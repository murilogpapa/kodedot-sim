/**
 * Turns a GLB (the bundled device model, or one the user loaded) into what the
 * 3D view can show and operate: a scene in the device frame, the place for the
 * live picture, the parts that move when pressed, the light guide.
 *
 * Everything happens in memory. The steps:
 *   1. parse (Draco and meshopt geometry, WebP textures, the material
 *      extensions three.js knows);
 *   2. find the device in it (analyse.ts): frame, screen, controls, LED, by
 *      the documented node names where present, by heuristics otherwise;
 *   3. bake every transform into the vertices, cut shared meshes apart where
 *      two controls live in one mesh;
 *   4. make it cheap to draw: one mesh per material for everything static,
 *      plain standard materials instead of clearcoat/anisotropy/transmission
 *      ("performance" mode), back faces culled where the winding allows it,
 *      oversized textures scaled down before they reach the GPU.
 *
 * This module pulls in three.js and its loaders: import it lazily.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Material,
  type MeshPhysicalMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ButtonId } from '../device/types';
import { SPEC } from '../lib/geometry';
import { analyse, geometryFromSpec, transformPoints, type Analysis, type ControlMatch, type PartInput, type Piece } from './analyse';

export const GEOMETRY = geometryFromSpec(SPEC);

export interface PrepareOptions {
  /** cheap materials, culling, small textures (default true) */
  performance?: boolean;
  /** measuring only: keep one mesh per source primitive and the file's own materials */
  raw?: boolean;
  /** largest texture side kept */
  maxTexture?: number;
}

export interface ModelStats {
  /** as in the file */
  sourceTriangles: number;
  sourceMeshes: number;
  sourceMaterials: number;
  /** as drawn */
  triangles: number;
  drawCalls: number;
  materials: number;
  texturesResized: number;
  prepareMs: number;
}

export interface PreparedModel {
  /** everything visible, in the device frame (mm) */
  root: Group;
  analysis: Analysis;
  /** where the 410 x 502 picture goes (device frame) */
  screen: { cx: number; cy: number; w: number; h: number; z: number };
  /** the file's own glass under the picture, when the detected screen surface is larger than the picture */
  glass: Mesh[];
  /** nodes that sink when their control is held */
  press: Partial<Record<ButtonId, Object3D>>;
  /** a one-piece D-pad: tilts about its centre */
  rocker: Object3D | null;
  /** centres of the invisible press targets: x, y and the z of the control's top */
  hit: { top: [number, number, number]; bottom: [number, number, number]; dpad: [number, number, number] };
  /** meshes of the light guide (their material is replaced by the live LED material); empty: use an overlay */
  led: Mesh[];
  /** dark, smooth, non-metallic materials: they mirror the darker studio, like the built-in glass */
  glossy: MeshStandardMaterial[];
  warnings: string[];
  stats: ModelStats;
  dispose(): void;
}

// ----------------------------------------------------------------- parsing
let loaderPromise: Promise<GLTFLoader> | null = null;

/** One loader for the session. The Draco decoder is fetched only if a file needs it; meshopt is a few kB of wasm in the bundle. */
async function gltfLoader(): Promise<GLTFLoader> {
  loaderPromise ??= (async () => {
    const loader = new GLTFLoader();
    const [{ MeshoptDecoder }, { makeDracoLoader }] = await Promise.all([import('three/examples/jsm/libs/meshopt_decoder.module.js'), import('./draco')]);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.setDRACOLoader(makeDracoLoader());
    return loader;
  })();
  return loaderPromise;
}

export async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  const loader = await gltfLoader();
  const gltf = await loader.parseAsync(buffer, '');
  const scene = gltf.scene ?? gltf.scenes?.[0];
  if (!scene) throw new Error('The file has no scene.');
  return scene;
}

// ------------------------------------------------------------------- parts
interface SourcePart {
  mesh: Mesh;
  material: Material;
  world: Float32Array;
  input: PartInput;
}

function floatAttribute(attr: { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; getW(i: number): number }, size: number): Float32Array {
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) {
    out[i * size] = attr.getX(i);
    if (size > 1) out[i * size + 1] = attr.getY(i);
    if (size > 2) out[i * size + 2] = attr.getZ(i);
  }
  return out;
}

/** Every triangle mesh of a scene as analyse.ts wants it. */
export function partsFromScene(scene: Object3D): SourcePart[] {
  scene.updateMatrixWorld(true);
  const parts: SourcePart[] = [];
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const m = material as MeshStandardMaterial;
    const world = transformPoints(mesh.matrixWorld.elements, floatAttribute(mesh.geometry.getAttribute('position'), 3));
    const nodeNames: string[] = [];
    for (let n: Object3D | null = mesh; n && n !== scene; n = n.parent) if (n.name) nodeNames.push(n.name);
    const e = m.emissive;
    parts.push({
      mesh,
      material,
      world,
      input: {
        nodeNames,
        otherNames: [mesh.geometry.name, material?.name ?? ''].filter(Boolean),
        positions: world,
        indices: mesh.geometry.index ? (mesh.geometry.index.array as ArrayLike<number>) : null,
        color: m.color ? [m.color.r, m.color.g, m.color.b] : [1, 1, 1],
        textured: !!m.map,
        emissive: !!e && e.r + e.g + e.b > 0 && !m.emissiveMap,
      },
    });
  });
  return parts;
}

// --------------------------------------------------------------- materials
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'] as const;

function cheapMaterial(src: Material, side: typeof FrontSide | typeof DoubleSide): MeshStandardMaterial {
  const s = src as MeshPhysicalMaterial;
  const out = new MeshStandardMaterial({ name: src.name, side });
  if (s.color) out.color.copy(s.color);
  out.roughness = s.roughness ?? 1;
  out.metalness = s.metalness ?? 0;
  for (const slot of TEXTURE_SLOTS) if (s[slot]) out[slot] = s[slot];
  if (s.normalScale) out.normalScale.copy(s.normalScale);
  if (s.emissive) out.emissive.copy(s.emissive);
  out.emissiveIntensity = Math.min(s.emissiveIntensity ?? 1, 1.5);
  // a clear coat reads as a glossy surface; transmission has no cheap equivalent: opaque
  if (s.clearcoat > 0) out.roughness = Math.min(out.roughness, 0.1 + (s.clearcoatRoughness ?? 0));
  out.transparent = src.transparent && !(s.transmission > 0);
  out.opacity = src.opacity;
  out.alphaTest = src.alphaTest;
  out.depthWrite = src.depthWrite;
  out.vertexColors = src.vertexColors;
  return out;
}

function materialKey(m: MeshStandardMaterial): string {
  return [m.color.getHexString(), m.roughness.toFixed(3), m.metalness.toFixed(3), m.emissive.getHexString(), m.emissiveIntensity.toFixed(2), m.transparent, m.opacity, m.alphaTest, m.side, m.vertexColors, m.normalScale.x, ...TEXTURE_SLOTS.map((s) => m[s]?.uuid ?? '-')].join('|');
}

async function shrinkTextures(materials: Iterable<Material>, max: number): Promise<number> {
  const seen = new Set<Texture>();
  for (const m of materials) for (const slot of TEXTURE_SLOTS) {
    const t = (m as MeshStandardMaterial)[slot];
    if (t) seen.add(t);
  }
  let resized = 0;
  for (const t of seen) {
    const img = t.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0, h = img?.height ?? 0;
    if (Math.max(w, h) <= max || typeof createImageBitmap !== 'function') continue;
    const k = max / Math.max(w, h);
    try {
      t.image = await createImageBitmap(img as ImageBitmapSource, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' });
      (img as ImageBitmap).close?.();
      t.needsUpdate = true;
      resized++;
    } catch {
      /* keep the original */
    }
  }
  return resized;
}

// ---------------------------------------------------------------- geometry
/** A float copy of a part's geometry in the device frame; `triangles` keeps only those triangles. */
function bake(part: SourcePart, total: Matrix4, positions: Float32Array, triangles: Uint32Array | null): BufferGeometry {
  const src = part.mesh.geometry;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  const n = src.getAttribute('normal');
  if (n) {
    const nm = floatAttribute(n, 3);
    const e = total.elements;
    // rotation and uniform scale only after analyse(); a node's own non-uniform scale is rare enough to accept
    for (let i = 0; i < nm.length; i += 3) {
      const x = nm[i], y = nm[i + 1], z = nm[i + 2];
      const a = e[0] * x + e[4] * y + e[8] * z, b = e[1] * x + e[5] * y + e[9] * z, c = e[2] * x + e[6] * y + e[10] * z;
      const l = Math.hypot(a, b, c) || 1;
      nm[i] = a / l; nm[i + 1] = b / l; nm[i + 2] = c / l;
    }
    g.setAttribute('normal', new BufferAttribute(nm, 3));
  }
  const uv = src.getAttribute('uv');
  g.setAttribute('uv', new BufferAttribute(uv ? floatAttribute(uv, 2) : new Float32Array((positions.length / 3) * 2), 2));
  const count = positions.length / 3;
  const index = src.index ? Array.from(src.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);
  let idx = index;
  if (triangles) {
    idx = [];
    for (const t of triangles) idx.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
  }
  if (total.determinant() < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  g.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  if (!n) g.computeVertexNormals();
  return g;
}

/** Share of triangles whose winding agrees with their vertex normals: 1 means back faces can be culled. */
function windingAgreement(g: BufferGeometry): number {
  const p = g.getAttribute('position').array as Float32Array, n = g.getAttribute('normal').array as Float32Array, idx = g.index!.array as ArrayLike<number>;
  let ok = 0, all = 0;
  const step = Math.max(1, Math.floor(idx.length / 3 / 4000)) * 3;
  for (let i = 0; i + 2 < idx.length; i += step) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx === 0 && gy === 0 && gz === 0) continue;
    all++;
    if (gx * (n[a] + n[b] + n[c]) + gy * (n[a + 1] + n[b + 1] + n[c + 1]) + gz * (n[a + 2] + n[b + 2] + n[c + 2]) > 0) ok++;
  }
  return all ? ok / all : 1;
}

// ------------------------------------------------------------------ prepare
export async function prepareModel(buffer: ArrayBuffer, options: PrepareOptions = {}): Promise<PreparedModel> {
  const scene = await parseGlb(buffer);
  return prepareScene(scene, options);
}

export async function prepareScene(scene: Object3D, options: PrepareOptions = {}): Promise<PreparedModel> {
  const t0 = performance.now();
  const perf = (options.performance ?? true) && !options.raw;
  const parts = partsFromScene(scene);
  if (!parts.length) throw new Error('The file has no triangle meshes.');
  const analysis = analyse(parts.map((p) => p.input), GEOMETRY);
  const A = new Matrix4().fromArray(analysis.matrix);

  const sourceMaterials = new Set(parts.map((p) => p.material));
  const texturesResized = await shrinkTextures(sourceMaterials, options.maxTexture ?? (perf ? 1024 : 2048));

  // which piece of which part goes where
  type Role = { kind: 'static' } | { kind: 'screen' } | { kind: 'led' } | { kind: 'control'; id: ButtonId | 'dpad' };
  const roles = new Map<number, { role: Role; triangles: Uint32Array | null }[]>();
  const give = (pc: Piece, role: Role) => {
    const list = roles.get(pc.part) ?? [];
    list.push({ role, triangles: pc.triangles });
    roles.set(pc.part, list);
  };
  if (analysis.screen.part !== null) give({ part: analysis.screen.part, triangles: null }, { kind: 'screen' });
  for (const i of analysis.led?.parts ?? []) give({ part: i, triangles: null }, { kind: 'led' });
  for (const [id, c] of Object.entries(analysis.controls) as [ButtonId | 'dpad', ControlMatch][]) for (const pc of c.pieces) give(pc, { kind: 'control', id });

  const root = new Group();
  root.name = 'model';
  const disposables: { dispose(): void }[] = [];
  const cheap = new Map<string, MeshStandardMaterial>();
  const materialFor = (part: SourcePart, g: BufferGeometry): Material => {
    if (!perf) return part.material;
    const cull = !part.material.transparent && windingAgreement(g) > 0.985;
    const m = cheapMaterial(part.material, cull ? FrontSide : DoubleSide);
    const key = materialKey(m);
    const have = cheap.get(key);
    if (have) {
      m.dispose();
      return have;
    }
    cheap.set(key, m);
    return m;
  };

  const statics = new Map<Material, BufferGeometry[]>();
  const glass: Mesh[] = [];
  const led: Mesh[] = [];
  const controlMeshes: Partial<Record<ButtonId | 'dpad', Mesh[]>> = {};
  let sourceTriangles = 0;

  parts.forEach((part, i) => {
    const total = new Matrix4().multiplyMatrices(A, part.mesh.matrixWorld);
    const positions = transformPoints(analysis.matrix, part.world);
    const triCount = (part.input.indices ? part.input.indices.length : positions.length / 3) / 3;
    sourceTriangles += triCount;
    const assigned = roles.get(i) ?? [{ role: { kind: 'static' } as Role, triangles: null }];
    for (const { role, triangles } of assigned) {
      const g = bake(part, total, positions, triangles);
      if (role.kind === 'screen') {
        // the picture itself is drawn by the viewer; a larger surface stays as the glass under it
        if (analysis.screen.surface === 'glass') {
          const mesh = new Mesh(g, part.material);
          mesh.name = 'glass';
          glass.push(mesh);
          root.add(mesh);
          disposables.push(g);
        } else g.dispose();
        continue;
      }
      const material = materialFor(part, g);
      if (role.kind === 'static' && !options.raw && !material.vertexColors) {
        const list = statics.get(material) ?? [];
        list.push(g);
        statics.set(material, list);
        continue;
      }
      const mesh = new Mesh(g, material);
      mesh.name = part.mesh.name;
      disposables.push(g);
      if (role.kind === 'led') led.push(mesh);
      if (role.kind === 'control') (controlMeshes[role.id] ??= []).push(mesh);
      else root.add(mesh);
    }
  });

  for (const [material, list] of statics) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (merged !== list[0]) list.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new Mesh(merged, material);
    mesh.name = `static:${material.name}`;
    root.add(mesh);
    disposables.push(merged);
  }

  // controls: one group each; the one-piece D-pad pivots about its centre at the front face
  const press: PreparedModel['press'] = {};
  let rocker: Object3D | null = null;
  const G = GEOMETRY;
  const proud = analysis.frontZ + 1.1;
  const hit: PreparedModel['hit'] = { top: [G.top.x, G.top.y, proud], bottom: [G.bottom.x, G.bottom.y, proud], dpad: [G.dpad.x, G.dpad.y, proud] };
  for (const [id, meshes] of Object.entries(controlMeshes) as [ButtonId | 'dpad', Mesh[]][]) {
    const c = analysis.controls[id]!;
    const group = new Group();
    if (id === 'dpad') {
      group.name = 'dpad';
      group.position.set(c.x, c.y, analysis.frontZ);
      for (const m of meshes) {
        m.geometry.translate(-c.x, -c.y, -analysis.frontZ);
        group.add(m);
      }
      rocker = group;
      hit.dpad = [c.x, c.y, c.z];
    } else {
      group.name = id === 'top' ? 'btn_top' : id === 'bottom' ? 'btn_bottom' : `dpad_${id}`;
      meshes.forEach((m) => group.add(m));
      press[id] = group;
      if (id === 'top' || id === 'bottom') hit[id] = [c.x, c.y, c.z];
    }
    root.add(group);
  }
  if (analysis.controls.up && analysis.controls.down && analysis.controls.left && analysis.controls.right) {
    const a = analysis.controls;
    hit.dpad = [(a.left!.x + a.right!.x) / 2, (a.up!.y + a.down!.y) / 2, Math.max(a.up!.z, a.down!.z, a.left!.z, a.right!.z)];
  }

  // dark, smooth dielectrics mirror the darker studio (see Device3D)
  const glossy: MeshStandardMaterial[] = [];
  const used = new Set<Material>();
  let triangles = 0, drawCalls = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    drawCalls++;
    triangles += (m.geometry.index?.count ?? 0) / 3;
    used.add(m.material as Material);
  });
  for (const m of used) {
    const s = m as MeshStandardMaterial;
    if (!s.isMeshStandardMaterial || s.transparent || s.metalness > 0.5) continue;
    const lum = 0.2126 * s.color.r + 0.7152 * s.color.g + 0.0722 * s.color.b;
    if ((!s.map && lum < 0.03 && s.roughness <= 0.3) || /glass/i.test(s.name)) glossy.push(s);
  }

  for (const m of perf ? cheap.values() : []) disposables.push(m);
  const textures = new Set<Texture>();
  for (const m of sourceMaterials) {
    disposables.push(m);
    for (const slot of TEXTURE_SLOTS) {
      const t = (m as MeshStandardMaterial)[slot];
      if (t) textures.add(t);
    }
  }
  textures.forEach((t) => disposables.push(t));

  return {
    root,
    analysis,
    screen: analysis.screen.rect,
    glass,
    press,
    rocker,
    hit,
    led,
    glossy,
    warnings: analysis.warnings,
    stats: { sourceTriangles, sourceMeshes: parts.length, sourceMaterials: sourceMaterials.size, triangles, drawCalls, materials: used.size, texturesResized, prepareMs: performance.now() - t0 },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
