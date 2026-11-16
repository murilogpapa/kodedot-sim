// Makes the bundled device model from the device maker's original model file.
//
//   node scripts/optimise-model.mjs <original.glb> [--out <file.glb>] [--budget <triangles>] [--no-notice]
//
// The original is only read (keep it outside the repository). The result goes
// to web/public/device/model.glb unless --out says otherwise, with a short
// credit note (NOTICE-model.md) beside it.
//
// What it does, in order:
//   1. reads the file (Draco geometry, WebP textures);
//   2. finds the device in it with the same code the page uses for models a
//      user loads (src/device3d/analyse.ts): removes the tilt every node
//      carries, scales to millimetres (front outline 46.65 x 77.0 mm), centres,
//      turns the front towards +Z and the top edge towards +Y;
//   3. bakes that into the vertices and renames the parts to the documented
//      node names: screen, btn_top, btn_bottom, dpad (one rocker), led. The
//      two round buttons share one mesh in the original: it is cut in two;
//      each button's coloured inlay joins its button;
//   4. adds the `screen` node: a flat rounded rectangle exactly over the lit
//      area of the glass, with clean planar UVs for the 410 x 502 picture. The
//      glass keeps its shape but loses the demo picture baked on it;
//   5. simplifies with meshoptimizer, part by part, to the triangle budget
//      (the screen, the light guide, the inlays and the side window are left
//      alone; the controls only lightly);
//   6. replaces clear coat / anisotropy / specular / IOR by plain
//      metallic-roughness materials with the maker's colours, joins static
//      parts that then share a material, scales the textures down to what the
//      page can show;
//   7. welds, removes duplicates and leftovers, and writes the file with
//      meshopt compression (decoded in the page by a few kB of WebAssembly, no
//      worker, no extra download; Draco would need its 280 kB decoder first).
//
// The maker's design is kept as it is, including the mark on the back.
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, getSceneVertexCount, joinPrimitives, meshopt, prune, simplifyPrimitive, VertexCountMethod, weldPrimitive } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, geometryFromSpec, transformPoints } from '../src/device3d/analyse.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const outFile = resolve(value('--out', join(root, 'public', 'device', 'model.glb')));
const BUDGET = Number(value('--budget', 40000));
const writeNotice = !args.includes('--no-notice');
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: node scripts/optimise-model.mjs <original.glb> [--out <file.glb>] [--budget <triangles>]');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(join(root, 'public', 'device', 'kode-dot.json'), 'utf8'));
const G = geometryFromSpec(spec);

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const src = await io.read(resolve(input));
const srcRoot = src.getRoot();
const triCount = (prim) => (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3;

// ---- 1-2. the parts as the analysis wants them
const parts = [];
for (const node of srcRoot.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const world = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const c = mat.getBaseColorFactor(), e = mat.getEmissiveFactor();
    const names = [];
    for (let n = node; n && n.getName; n = n.getParentNode?.()) names.push(n.getName());
    parts.push({
      node, mesh, prim, mat, world,
      input: {
        nodeNames: names.filter(Boolean),
        otherNames: [mesh.getName(), mat.getName()].filter(Boolean),
        positions: transformPoints(world, prim.getAttribute('POSITION').getArray()),
        indices: prim.getIndices() ? prim.getIndices().getArray() : null,
        color: [c[0], c[1], c[2]],
        textured: !!mat.getBaseColorTexture(),
        emissive: e[0] + e[1] + e[2] > 0 && !mat.getEmissiveTexture(),
      },
    });
  }
}
const sourceTriangles = parts.reduce((s, p) => s + triCount(p.prim), 0);
const A = analyse(parts.map((p) => p.input), G);
console.log(`original: ${sourceTriangles} triangles, ${parts.length} primitives, ${srcRoot.listMaterials().length} materials, ${srcRoot.listTextures().length} textures, ${(statSync(resolve(input)).size / 1024).toFixed(0)} kB`);
console.log(`found: scale x${A.scale.toFixed(1)}, front at z=${A.frontZ.toFixed(2)} mm, depth ${(A.bounds.max[2] - A.bounds.min[2]).toFixed(2)} mm with the controls`);
for (const w of A.warnings) console.log(`  - ${w}`);
if (A.screen.part === null || !A.controls.top || !A.controls.bottom || !A.controls.dpad || !A.led) throw new Error('A part of the device was not found in this file: nothing written.');

// ---- 3. a new document in the device frame
const doc = new Document();
doc.createBuffer();
const scene = doc.createScene('Kode Dot');
doc.getRoot().setDefaultScene(scene);
doc.getRoot().getAsset().generator = 'dotbench scripts/optimise-model.mjs (glTF-Transform)';

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** A primitive of the original, baked into the device frame; `triangles` keeps only those. */
function bake(part, triangles) {
  const total = mul(A.matrix, part.world);
  const sp = part.prim;
  const prim = doc.createPrimitive();
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(transformPoints(total, sp.getAttribute('POSITION').getArray())));
  const sn = sp.getAttribute('NORMAL');
  if (sn) {
    const n = Float32Array.from(sn.getArray());
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i], y = n[i + 1], z = n[i + 2];
      const a = total[0] * x + total[4] * y + total[8] * z, b = total[1] * x + total[5] * y + total[9] * z, c = total[2] * x + total[6] * y + total[10] * z;
      const l = Math.hypot(a, b, c) || 1;
      n[i] = a / l; n[i + 1] = b / l; n[i + 2] = c / l;
    }
    prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(n));
  }
  const uv = sp.getAttribute('TEXCOORD_0');
  if (uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(Float32Array.from(uv.getArray())));
  const all = sp.getIndices() ? Array.from(sp.getIndices().getArray()) : Array.from({ length: sp.getAttribute('POSITION').getCount() }, (_, i) => i);
  let idx = all;
  if (triangles) {
    idx = [];
    for (const t of triangles) idx.push(all[t * 3], all[t * 3 + 1], all[t * 3 + 2]);
  }
  if (det3(total) < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)));
  if (triangles) compactPrimitive(prim);
  return prim;
}

// ---- 6a. materials: the maker's colours and textures, plain metallic-roughness
const textureCopies = new Map();
async function copyTexture(t, maxSide, { lossless = false } = {}) {
  if (!t) return null;
  const key = `${t.getName()}|${maxSide}`;
  if (textureCopies.has(key)) return textureCopies.get(key);
  const img = sharp(t.getImage());
  const meta = await img.metadata();
  const k = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * k)), h = Math.max(1, Math.round(meta.height * k));
  const tiny = Math.max(meta.width, meta.height) <= 64;
  const data = tiny ? t.getImage() : await img.resize(w, h, { kernel: 'lanczos3' }).webp(lossless ? { lossless: true } : { quality: 88, alphaQuality: 95, effort: 6 }).toBuffer();
  const copy = doc.createTexture(t.getName()).setMimeType('image/webp').setImage(new Uint8Array(data));
  console.log(`  texture "${t.getName()}": ${meta.width}x${meta.height} (${(t.getImage().byteLength / 1024).toFixed(0)} kB) -> ${tiny ? 'kept' : `${w}x${h}`} (${(data.byteLength / 1024).toFixed(0)} kB)`);
  textureCopies.set(key, copy);
  return copy;
}
const copyInfo = (from, to) => to && from && to.setWrapS(from.getWrapS()).setWrapT(from.getWrapT()).setMagFilter(from.getMagFilter()).setMinFilter(from.getMinFilter());

/**
 * How the page shows the device: at most about 900 px tall on a 2x display.
 * The body's baked normal maps cover the whole shell in one sheet: 1024 px.
 * The buttons' maps hold only a fine grain: 256 px. The pin labels: 1024 px wide.
 */
const TEXTURE_SIDE = { front_body: 1024, back_body: 1024, 'left buttom': 256, 'right button': 256, 'Frame 2147223613': 1024 };

const materials = new Map();
async function material(srcMat, role) {
  const key = `${srcMat.getName()}|${role}`;
  if (materials.has(key)) return materials.get(key);
  const ext = (n) => srcMat.getExtension(n);
  const m = doc.createMaterial(srcMat.getName());
  m.setBaseColorFactor(srcMat.getBaseColorFactor()).setMetallicFactor(srcMat.getMetallicFactor()).setRoughnessFactor(srcMat.getRoughnessFactor());
  m.setAlphaMode(srcMat.getAlphaMode()).setAlphaCutoff(srcMat.getAlphaCutoff());
  const side = (t) => TEXTURE_SIDE[t?.getName()] ?? 1024;
  if (role !== 'glass') {
    const bc = await copyTexture(srcMat.getBaseColorTexture(), side(srcMat.getBaseColorTexture()));
    if (bc) { m.setBaseColorTexture(bc); copyInfo(srcMat.getBaseColorTextureInfo(), m.getBaseColorTextureInfo()); }
    const mr = await copyTexture(srcMat.getMetallicRoughnessTexture(), 1024);
    if (mr) { m.setMetallicRoughnessTexture(mr); copyInfo(srcMat.getMetallicRoughnessTextureInfo(), m.getMetallicRoughnessTextureInfo()); }
    const nt = await copyTexture(srcMat.getNormalTexture(), side(srcMat.getNormalTexture()));
    if (nt) { m.setNormalTexture(nt).setNormalScale(srcMat.getNormalScale()); copyInfo(srcMat.getNormalTextureInfo(), m.getNormalTextureInfo()); }
    m.setEmissiveFactor(srcMat.getEmissiveFactor());
  }
  // the extensions, folded into the plain model
  const clearcoat = ext('KHR_materials_clearcoat');
  const specular = ext('KHR_materials_specular');
  if (clearcoat && clearcoat.getClearcoatFactor() > 0) m.setRoughnessFactor(Math.min(m.getRoughnessFactor(), 0.1 + clearcoat.getClearcoatRoughnessFactor()));
  // a specular factor of 0 is "no highlight at all": fully rough says the same. In between (the rubbery buttons): soft, wide highlight
  if (specular && !srcMat.getMetallicRoughnessTexture()) m.setRoughnessFactor(specular.getSpecularFactor() === 0 ? 1 : Math.min(m.getRoughnessFactor(), 0.82));
  // back faces are never seen on a closed shell; the original marks everything double-sided
  m.setDoubleSided(srcMat.getAlphaMode() === 'BLEND');
  if (role === 'glass') {
    // the black glass under the live picture: the demo picture baked on it goes
    m.setName('glass').setBaseColorFactor([0.004, 0.004, 0.005, 1]).setEmissiveFactor([0, 0, 0]);
  }
  if (role === 'window') m.setName('side_window_glass');
  materials.set(key, m);
  return m;
}

// ---- roles
const role = new Map(); // part index -> [{ kind, triangles }]
const give = (i, kind, triangles = null) => role.set(i, [...(role.get(i) ?? []), { kind, triangles }]);
give(A.screen.part, 'glass');
for (const i of A.led.parts) give(i, 'led');
for (const id of ['top', 'bottom', 'dpad']) for (const pc of A.controls[id].pieces) give(pc.part, id, pc.triangles);

const groups = { static: [], glass: [], led: [], top: [], bottom: [], dpad: [] };
for (let i = 0; i < parts.length; i++) {
  const p = parts[i];
  for (const r of role.get(i) ?? [{ kind: 'static', triangles: null }]) {
    const prim = bake(p, r.triangles);
    const isWindow = !!p.mat.getExtension('KHR_materials_clearcoat');
    prim.setMaterial(await material(p.mat, r.kind === 'glass' ? 'glass' : isWindow ? 'window' : 'plain'));
    groups[r.kind].push({ prim, name: p.node.getName(), matName: p.mat.getName(), source: triCount(prim) });
  }
}

// ---- 5. simplify, part by part
/**
 * How much of each kind of part may go, as the share of triangles to keep, and
 * the largest error allowed (a fraction of the part's size). Chosen by looking
 * at renders next to the original. Flat CAD faces lose nothing visible; what
 * limits the budget is the fillets, the speaker holes and the logo's edges.
 */
function plan(entry, kind) {
  const n = entry.source;
  if (kind === 'glass' || kind === 'led' || n < 600) return null; // the screen surface, the light guide, the inlays, the window: untouched
  if (kind === 'top' || kind === 'bottom' || kind === 'dpad') return { ratio: 0.55, error: 0.0012 };
  if (/main_white_body/.test(entry.matName)) return { ratio: 0.42, error: 0.0009 }; // the shell: silhouette, fillets, grille, logo
  return { ratio: 0.2, error: 0.004 }; // dark parts behind the shell (seen only through its openings), contacts
}
function simplifyGroup(kind) {
  for (const e of groups[kind]) {
    weldPrimitive(e.prim, {});
    const p = plan(e, kind);
    if (p) simplifyPrimitive(e.prim, { simplifier: MeshoptSimplifier, ratio: p.ratio * SCALE, error: p.error, lockBorder: false });
    e.after = triCount(e.prim);
  }
}
// scale all ratios so the total lands on the budget
let SCALE = 1;
{
  let fixed = 0, flexible = 0;
  for (const kind of Object.keys(groups)) for (const e of groups[kind]) {
    const p = plan(e, kind);
    if (p) flexible += e.source * p.ratio;
    else fixed += e.source;
  }
  SCALE = Math.min(1 / 0.55, Math.max(0.2, (BUDGET - fixed) / flexible));
}
for (const kind of Object.keys(groups)) simplifyGroup(kind);

// ---- 6b. join static parts that share a material; build the nodes
const byMaterial = new Map();
for (const e of groups.static) byMaterial.set(e.prim.getMaterial(), [...(byMaterial.get(e.prim.getMaterial()) ?? []), e]);
// materials that became identical (the palette materials differed only in their extensions)
const sameMaterial = (a, b) => a !== b && a.equals(b, new Set(['name']));
const mats = [...byMaterial.keys()];
for (let i = 0; i < mats.length; i++) for (let j = i + 1; j < mats.length; j++) {
  if (!byMaterial.has(mats[i]) || !byMaterial.has(mats[j]) || !sameMaterial(mats[i], mats[j])) continue;
  for (const e of byMaterial.get(mats[j])) e.prim.setMaterial(mats[i]);
  byMaterial.set(mats[i], [...byMaterial.get(mats[i]), ...byMaterial.get(mats[j])]);
  byMaterial.delete(mats[j]);
}
const body = doc.createMesh('body');
for (const [mat, list] of byMaterial) {
  const attrs = (e) => e.prim.listSemantics().sort().join();
  const joinable = list.every((e) => attrs(e) === attrs(list[0]));
  if (list.length > 1 && joinable) body.addPrimitive(joinPrimitives(list.map((e) => e.prim)).setMaterial(mat));
  else for (const e of list) body.addPrimitive(e.prim);
}
scene.addChild(doc.createNode('body').setMesh(body));
const addNode = (name, list) => {
  const mesh = doc.createMesh(name);
  for (const e of list) mesh.addPrimitive(e.prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
};
addNode('glass', groups.glass);
addNode('btn_top', groups.top);
addNode('btn_bottom', groups.bottom);
addNode('dpad', groups.dpad);
addNode('led', groups.led);

// ---- 4. the screen: a flat rounded rectangle over the lit area, planar UVs (glTF: v runs down)
{
  const { cx, cy, w, h, z } = A.screen.rect;
  const r = Math.min(spec.screen_px.corner_r_mm * (w / G.screen.w), w / 2, h / 2);
  const ring = [];
  const corners = [[cx + w / 2 - r, cy - h / 2 + r, -90], [cx + w / 2 - r, cy + h / 2 - r, 0], [cx - w / 2 + r, cy + h / 2 - r, 90], [cx - w / 2 + r, cy - h / 2 + r, 180]];
  for (const [ox, oy, a0] of corners) for (let i = 0; i <= 12; i++) {
    const a = ((a0 + i * 7.5) * Math.PI) / 180;
    ring.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
  }
  const pos = [cx, cy, z + 0.02], uv = [0.5, 0.5], nrm = [0, 0, 1], idx = [];
  ring.forEach(([x, y], i) => {
    pos.push(x, y, z + 0.02);
    nrm.push(0, 0, 1);
    uv.push((x - (cx - w / 2)) / w, (cy + h / 2 - y) / h);
    idx.push(0, i + 1, ((i + 1) % ring.length) + 1);
  });
  const mat = doc.createMaterial('screen').setBaseColorFactor([0, 0, 0, 1]).setRoughnessFactor(0.2).setMetallicFactor(0);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)));
  scene.addChild(doc.createNode('screen').setMesh(doc.createMesh('screen').addPrimitive(prim)));
}

// ---- 7. clean up and write
await doc.transform(dedup(), prune({ keepAttributes: false }));
const triangles = doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((q, p) => q + triCount(p), 0), 0);
const drawCalls = doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().length, 0);
const vertices = getSceneVertexCount(scene, VertexCountMethod.UPLOAD);
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
mkdirSync(dirname(outFile), { recursive: true });
const bytes = await io.writeBinary(doc);
writeFileSync(outFile, bytes);

const line = (kind) => groups[kind].map((e) => `${e.name} [${e.matName}] ${e.source} -> ${e.after}`).join('; ');
console.log('simplified (triangles before -> after):');
for (const kind of Object.keys(groups)) console.log(`  ${kind}: ${line(kind)}`);
console.log(`optimised: ${triangles} triangles (was ${sourceTriangles}), ${vertices} vertices, ${drawCalls} primitives (draw calls), ${doc.getRoot().listMaterials().length} materials, ${doc.getRoot().listTextures().length} textures`);
console.log(`written: ${outFile} (${(bytes.byteLength / 1024).toFixed(0)} kB, was ${(statSync(resolve(input)).size / 1024).toFixed(0)} kB); extensions required: ${doc.getRoot().listExtensionsRequired().map((e) => e.extensionName).join(', ')}`);

if (writeNotice) {
  const notice = `# The bundled device model (model.glb)

\`model.glb\` in this folder is the 3D model of the Kode Dot made by its maker,
Kode (KODE DIY SL), as offered on the maker's web site. It is shown in this
unofficial simulator as the maker's work, following the maker's statement to
its community that material from its site may be used for community projects.
It is the maker's design, not this project's, and is not covered by this
repository's GPL licence.

The file here is not the original: \`scripts/optimise-model.mjs\` makes it from
the original so that it loads and draws quickly in a web page. What the script
changed:

- placement: the tilt every node carried is removed, the model is in
  millimetres, centred, front towards +Z, top edge towards +Y;
- names: the parts are named \`screen\`, \`btn_top\`, \`btn_bottom\`, \`dpad\`, \`led\`
  (see MODEL.md); the two round buttons, one mesh in the original, are two;
- the demo picture baked on the glass is removed (the simulator draws the live
  screen there) and a flat \`screen\` surface is added over the lit area;
- geometry: ${sourceTriangles} triangles simplified to ${triangles} with meshoptimizer; the
  screen surface, the light guide, the button inlays and the side window are
  untouched;
- materials: clear coat, anisotropy, specular and IOR are replaced by plain
  metallic-roughness materials with the same colours and textures;
- textures: scaled down from 2048 px (the body's maps to 1024 px, the buttons'
  grain to 256 px);
- compression: meshopt instead of Draco; ${(statSync(resolve(input)).size / 1024).toFixed(0)} kB became ${(bytes.byteLength / 1024).toFixed(0)} kB.

Nothing of the design was redrawn: shapes, colours and the mark on the back are
the maker's.
`;
  writeFileSync(join(dirname(outFile), 'NOTICE-model.md'), notice);
  console.log(`written: ${join(dirname(outFile), 'NOTICE-model.md')}`);
}
