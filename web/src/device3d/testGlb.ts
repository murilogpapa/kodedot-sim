/**
 * Test helper: writes small binary glTF files in code (boxes only), so the
 * loader and the heuristics are tested on real GLB bytes without checking any
 * model into the repository. Not imported by the application.
 */
export interface TestBox {
  /** node name (and the names of enclosing nodes, outermost first, if any) */
  name: string;
  parents?: string[];
  material?: string;
  /** one or more boxes forming ONE mesh: centre and size, in the device frame (mm) */
  boxes: { c: [number, number, number]; s: [number, number, number] }[];
  colour?: [number, number, number];
  emissive?: [number, number, number];
  roughness?: number;
}

export interface TestGlbOptions {
  /** how the whole device is placed in the file: rotation (unit quaternion xyzw), uniform scale, translation */
  rotation?: [number, number, number, number];
  scale?: number;
  translation?: [number, number, number];
  /** put the placement on every node (as CAD exports do) instead of baking it into the vertices */
  onNodes?: boolean;
  extensionsRequired?: string[];
}

function boxGeometry(boxes: TestBox['boxes']) {
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const { c, s } of boxes)
    for (const [nn, u, v] of faces) {
      const base = p.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        for (let k = 0; k < 3; k++) p.push(c[k] + ((nn[k] + a * u[k] + b * v[k]) * s[k]) / 2);
      for (let q = 0; q < 4; q++) n.push(...nn);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  return { p, n, idx };
}

function rotate(q: [number, number, number, number], v: number[]): [number, number, number] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function makeTestGlb(parts: TestBox[], o: TestGlbOptions = {}): ArrayBuffer {
  const q = o.rotation ?? [0, 0, 0, 1], sc = o.scale ?? 1, tr = o.translation ?? [0, 0, 0];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const views: object[] = [], accessors: object[] = [], meshes: object[] = [], nodes: Record<string, unknown>[] = [], materials: object[] = [];
  const push = (typed: Float32Array | Uint16Array, target: number) => {
    const bytes = new Uint8Array(typed.buffer.slice(0));
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
    return views.length - 1;
  };
  const roots: number[] = [];
  parts.forEach((part, i) => {
    const g = boxGeometry(part.boxes);
    if (!o.onNodes) {
      for (let k = 0; k < g.p.length; k += 3) {
        const r = rotate(q, g.p.slice(k, k + 3));
        for (let c = 0; c < 3; c++) g.p[k + c] = r[c] * sc + tr[c];
        const rn = rotate(q, g.n.slice(k, k + 3));
        for (let c = 0; c < 3; c++) g.n[k + c] = rn[c];
      }
    }
    const P = new Float32Array(g.p);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k++) { min[k % 3] = Math.min(min[k % 3], P[k]); max[k % 3] = Math.max(max[k % 3], P[k]); }
    const a0 = accessors.length;
    accessors.push({ bufferView: push(P, 34962), componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: push(new Float32Array(g.n), 34962), componentType: 5126, count: P.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: push(new Uint16Array(g.idx), 34963), componentType: 5123, count: g.idx.length, type: 'SCALAR' });
    materials.push({ name: part.material ?? `m${i}`, pbrMetallicRoughness: { baseColorFactor: [...(part.colour ?? [0.8, 0.75, 0.68]), 1], metallicFactor: 0, roughnessFactor: part.roughness ?? 0.8 }, ...(part.emissive ? { emissiveFactor: part.emissive } : {}) });
    meshes.push({ primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1 }, indices: a0 + 2, material: i }] });
    const node: Record<string, unknown> = { name: part.name, mesh: i };
    if (o.onNodes) Object.assign(node, { rotation: q, scale: [sc, sc, sc], translation: tr });
    nodes.push(node);
    let top = nodes.length - 1;
    for (const parent of [...(part.parents ?? [])].reverse()) {
      nodes.push({ name: parent, children: [top] });
      top = nodes.length - 1;
    }
    roots.push(top);
  });
  const json = { asset: { version: '2.0', generator: 'dotbench test' }, scene: 0, scenes: [{ nodes: roots }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }], ...(o.extensionsRequired ? { extensionsRequired: o.extensionsRequired, extensionsUsed: o.extensionsRequired } : {}) };
  let jb = new TextEncoder().encode(JSON.stringify(json));
  if (jb.length % 4) {
    const padded = new Uint8Array(jb.length + 4 - (jb.length % 4)).fill(0x20);
    padded.set(jb);
    jb = padded;
  }
  const total = 12 + 8 + jb.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jb, 20);
  dv.setUint32(20 + jb.length, offset, true); dv.setUint32(24 + jb.length, 0x004e4942, true);
  let at = 28 + jb.length;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

/** A box-built stand-in for the device, in the device frame (mm). `names`: how its parts are called. */
export function testDevice(names: 'contract' | 'cad' | 'none', opts: { joinedButtons?: boolean; rockerDpad?: boolean } = {}): TestBox[] {
  const zf = 9.75;
  const n = (contract: string, cad: string, i: number) => (names === 'contract' ? contract : names === 'cad' ? cad : `Object_${i}`);
  const cream: [number, number, number] = [0.73, 0.68, 0.61], black: [number, number, number] = [0.006, 0.006, 0.006];
  const T: [number, number, number] = [12.954, -19.475, zf + 0.3], B: [number, number, number] = [8.249, -30.783, zf + 0.3], D: [number, number] = [-8.249, -25.133];
  const out: TestBox[] = [
    { name: n('body', 'Shell.001', 0), material: names === 'cad' ? 'main_white_body' : 'mat0', colour: cream, boxes: [{ c: [0, 0, 0], s: [46.65, 77, 19.5] }] },
    // the glass: larger than the picture, flush with the front, upper half
    names === 'contract'
      ? { name: 'screen', colour: black, roughness: 0.1, boxes: [{ c: [0, 11.21, zf], s: [33.09, 40.52, 0.1] }] }
      : { name: n('', 'Cut-Extrude1.020', 1), material: names === 'cad' ? 'screen 1' : 'mat1', colour: black, roughness: 0.1, boxes: [{ c: [0, 11.21, zf - 0.5], s: [39.06, 47.13, 1] }] },
    { name: n('led', 'Fillet1.053', 2), colour: [0.9, 0.9, 0.5], emissive: [1, 1, 0], boxes: [{ c: [20, 35.2, zf - 0.4], s: [3.6, 3.6, 1] }] },
    // something inside, behind a button: must not be taken for a control
    { name: n('pcb', 'PCB', 3), colour: [0.05, 0.3, 0.1], boxes: [{ c: [8, -25, 2], s: [20, 20, 1] }] },
  ];
  const arm = (dx: number, dy: number): TestBox['boxes'][number] => ({ c: [D[0] + dx, D[1] + dy, zf + 0.4], s: dx ? [8, 5.9, 2] : [5.9, 8, 2] });
  if (names === 'contract' && !opts.rockerDpad) {
    out.push({ name: 'dpad_up', colour: black, boxes: [arm(0, 6)] }, { name: 'dpad_down', colour: black, boxes: [arm(0, -6)] }, { name: 'dpad_left', colour: black, boxes: [arm(-6, 0)] }, { name: 'dpad_right', colour: black, boxes: [arm(6, 0)] });
  } else {
    out.push({ name: n('dpad', 'brep_1[1].006', 4), material: names === 'cad' ? 'buttons.001' : 'mat4', colour: black, boxes: [{ c: [D[0], D[1], zf + 0.4], s: [20.5, 5.9, 2] }, { c: [D[0], D[1], zf + 0.4], s: [5.9, 20.5, 2] }] });
  }
  const cap = (c: [number, number, number]): TestBox['boxes'][number] => ({ c, s: [8.4, 8.4, 2] });
  if (opts.joinedButtons) out.push({ name: n('', 'Cavity_Draft.018', 5), material: names === 'cad' ? 'buttons' : 'mat5', colour: black, boxes: [cap(T), cap(B)] });
  else out.push({ name: n('btn_top', 'ButtonB', 5), colour: black, boxes: [cap(T)] }, { name: n('btn_bottom', 'ButtonA', 6), colour: black, boxes: [cap(B)] });
  // coloured inlays: separate small meshes on top of the buttons
  out.push({ name: n('inlay_top', 'Cavity_Draft.019', 7), colour: [0, 0.25, 0.54], boxes: [{ c: [T[0], T[1], zf + 1.35], s: [5, 5, 0.1] }] });
  return out;
}
