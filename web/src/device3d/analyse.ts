/**
 * Finding the device in an arbitrary model file: where it is, which way it
 * faces, how big it is, and which meshes are the screen, the two round
 * buttons, the D-pad and the light guide.
 *
 * Pure maths on plain arrays: NO imports at all, on purpose. The 3D view uses
 * it on models the user loads (src/device3d/prepare.ts) and the offline
 * optimiser uses the very same code (scripts/optimise-model.mjs, through
 * Node's type stripping), so both agree on what a part is.
 *
 * Device frame (as everywhere in this folder): millimetres, origin at the
 * centre of the body, +X right, +Y up, +Z towards the viewer.
 */

// ------------------------------------------------------------------ inputs
export interface PartInput {
  /** names of the node and its ancestors, nearest first (the documented node names are looked up here) */
  nodeNames: string[];
  /** mesh and material names (free text; searched for words like "screen" and "button") */
  otherNames: string[];
  /** xyz triples, in the file's world space */
  positions: ArrayLike<number>;
  /** triangle list, or null for a non-indexed triangle soup */
  indices: ArrayLike<number> | null;
  /** base colour factor, linear RGB */
  color: [number, number, number];
  /** has a base colour texture (its colour is then unknown here) */
  textured: boolean;
  /** glows on its own with a plain colour (emissive factor, no emissive texture) */
  emissive: boolean;
}

/** What the real device measures, in the device frame (from public/device/kode-dot.json). */
export interface DeviceGeometry {
  width: number;
  height: number;
  /** lit picture (410 x 502 px) */
  screen: { cx: number; cy: number; w: number; h: number };
  /** black glass around it */
  glass: { w: number; h: number };
  top: { x: number; y: number; r: number };
  bottom: { x: number; y: number; r: number };
  dpad: { x: number; y: number; half: number };
  led: { x: number; y: number };
}

interface SpecLike {
  px_per_mm: number;
  body_px: { x: number[]; y: number[] };
  screen_px: { x: number; y: number; w: number; h: number };
  top_px: { cx: number; cy: number; d: number };
  bot_px: { cx: number; cy: number; d: number };
  dpad_px: { cx: number; cy: number; span: number };
  led_guide_px: { x: number[]; y: number[] };
}

/** `glassMarginPx`: black border beyond the picture, [sides, top and bottom], measured on the maker's render. */
export function geometryFromSpec(spec: SpecLike, glassMarginPx: [number, number] = [37, 41]): DeviceGeometry {
  const k = spec.px_per_mm;
  const x0 = spec.body_px.x[0], x1 = spec.body_px.x[1] + 1, y0 = spec.body_px.y[0], y1 = spec.body_px.y[1] + 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const mm = (px: number, py: number) => ({ x: (px - cx) / k, y: -(py - cy) / k });
  const s = spec.screen_px;
  const sc = mm(s.x + s.w / 2, s.y + s.h / 2);
  const t = mm(spec.top_px.cx, spec.top_px.cy), b = mm(spec.bot_px.cx, spec.bot_px.cy), d = mm(spec.dpad_px.cx, spec.dpad_px.cy);
  const l = mm((spec.led_guide_px.x[0] + spec.led_guide_px.x[1] + 1) / 2, (spec.led_guide_px.y[0] + spec.led_guide_px.y[1] + 1) / 2);
  return {
    width: (x1 - x0) / k,
    height: (y1 - y0) / k,
    screen: { cx: sc.x, cy: sc.y, w: s.w / k, h: s.h / k },
    glass: { w: (s.w + 2 * glassMarginPx[0]) / k, h: (s.h + 2 * glassMarginPx[1]) / k },
    top: { x: t.x, y: t.y, r: spec.top_px.d / 2 / k },
    bottom: { x: b.x, y: b.y, r: spec.bot_px.d / 2 / k },
    dpad: { x: d.x, y: d.y, half: spec.dpad_px.span / 2 / k },
    led: { x: l.x, y: l.y },
  };
}

// ----------------------------------------------------------------- outputs
export type ControlId = 'top' | 'bottom' | 'dpad' | 'up' | 'down' | 'left' | 'right';
/** node = a documented node name; name = a telling word in a name; position/heuristic = found by shape and place */
export type How = 'node' | 'name' | 'position' | 'heuristic';

export interface Piece {
  /** index into the parts given to analyse() */
  part: number;
  /** triangle numbers of that part belonging to this piece, or null for the whole part */
  triangles: Uint32Array | null;
}

export interface ControlMatch {
  how: How;
  pieces: Piece[];
  /** centre of the control (x, y) and the z of its top surface, device frame */
  x: number;
  y: number;
  z: number;
}

export interface Analysis {
  /** column-major 4x4: device = matrix * world */
  matrix: number[];
  /** the file already was in the device frame with every documented node present: nothing was moved */
  trusted: boolean;
  /** uniform scale applied (device mm per file unit) */
  scale: number;
  /** z of the front face (the glass) */
  frontZ: number;
  /** bounding box of everything, device frame */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  screen: {
    how: How | 'overlay';
    part: number | null;
    /** 'picture': the part is the lit picture itself; 'glass': it is larger, the picture sits in its middle */
    surface: 'picture' | 'glass' | 'none';
    /** where the 410 x 502 picture goes */
    rect: { cx: number; cy: number; w: number; h: number; z: number };
  };
  controls: Partial<Record<ControlId, ControlMatch>>;
  led: { how: How; parts: number[] } | null;
  warnings: string[];
}

export const REQUIRED_NODES = ['screen', 'btn_top', 'btn_bottom', 'led'] as const;
export const DPAD_ARM_NODES = { up: 'dpad_up', down: 'dpad_down', left: 'dpad_left', right: 'dpad_right' } as const;
export const DPAD_ROCKER_NODE = 'dpad';

const SCREEN_WORDS = /screen|display|lcd/i;
const CONTROL_WORDS = /button|btn|d-?pad|\bkey|cross|arrow/i;
const LED_WORDS = /(^|[^a-z])led([^a-z]|$)|light.?(guide|pipe)/i;

// ------------------------------------------------------------- small maths
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Eigenvectors (columns, as three vectors) and eigenvalues of a symmetric 3x3 matrix, by Jacobi rotations. */
export function eigenSymmetric3(m: number[][]): { values: number[]; vectors: V3[] } {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [0, 1, 2].map((i): V3 => [v[0][i], v[1][i], v[2][i]]) };
}

const triCount = (p: PartInput) => (p.indices ? p.indices.length : p.positions.length / 3) / 3;

/** Calls f(a, b, c, triangleNumber) with vertex numbers for every triangle. */
function eachTriangle(p: PartInput, f: (a: number, b: number, c: number, t: number) => void) {
  const n = triCount(p);
  if (p.indices) for (let t = 0; t < n; t++) f(p.indices[t * 3], p.indices[t * 3 + 1], p.indices[t * 3 + 2], t);
  else for (let t = 0; t < n; t++) f(t * 3, t * 3 + 1, t * 3 + 2, t);
}

/** Area-weighted normal (length = twice the area) of a triangle of `pos`. */
function triNormal(pos: ArrayLike<number>, a: number, b: number, c: number): V3 {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * The three axes of a box-like object from its face normals: the eigenvectors
 * of the area-weighted normal covariance, each then replaced by the mean
 * normal of the flat faces around it (so a taper or a fillet does not tilt the
 * result). Returned unsigned and unordered.
 */
export function principalAxes(parts: PartInput[]): V3[] {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of parts)
    eachTriangle(p, (a, b, c) => {
      const n = triNormal(p.positions, a, b, c);
      const l = Math.hypot(n[0], n[1], n[2]);
      if (!(l > 0)) return;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += (n[i] * n[j]) / l;
    });
  const axes = eigenSymmetric3(m).vectors.map(norm);
  for (const cos of [Math.cos((12 * Math.PI) / 180), Math.cos((2.5 * Math.PI) / 180)])
    for (let k = 0; k < 3; k++) {
      const ax = axes[k];
      const sum: V3 = [0, 0, 0];
      for (const p of parts)
        eachTriangle(p, (a, b, c) => {
          const n = triNormal(p.positions, a, b, c);
          const l = Math.hypot(n[0], n[1], n[2]);
          if (!(l > 0)) return;
          const d = dot(n, ax) / l;
          if (Math.abs(d) < cos) return;
          const s = d < 0 ? -1 : 1;
          sum[0] += n[0] * s; sum[1] += n[1] * s; sum[2] += n[2] * s;
        });
      if (Math.hypot(sum[0], sum[1], sum[2]) > 0) axes[k] = norm(sum);
    }
  return axes;
}

// --------------------------------------------------------------- descriptors
interface Desc {
  min: V3;
  max: V3;
  /** flat faces looking along +Z: total area, their bounding rectangle, their area-weighted mean z */
  flat: { area: number; x0: number; x1: number; y0: number; y1: number; z: number };
  lum: number;
}

function describe(p: PartInput, pos: Float32Array): Desc {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  const flat = { area: 0, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z: 0 };
  eachTriangle(p, (a, b, c) => {
    const n = triNormal(pos, a, b, c);
    const l = Math.hypot(n[0], n[1], n[2]);
    // either winding counts: CAD exports are often double-sided with mixed winding
    if (!(l > 0) || Math.abs(n[2]) / l < 0.985) return;
    const area = l / 2;
    flat.area += area;
    flat.z += area * (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    for (const v of [a, b, c]) {
      const x = pos[v * 3], y = pos[v * 3 + 1];
      if (x < flat.x0) flat.x0 = x;
      if (x > flat.x1) flat.x1 = x;
      if (y < flat.y0) flat.y0 = y;
      if (y > flat.y1) flat.y1 = y;
    }
  });
  if (flat.area > 0) flat.z /= flat.area;
  return { min, max, flat, lum: 0.2126 * p.color[0] + 0.7152 * p.color[1] + 0.0722 * p.color[2] };
}

/**
 * Flat faces of a part that lie on its outer side along z (`side` = +1 front,
 * -1 back): only faces within `slack` of the part's extreme count.
 */
function outerFlat(p: PartInput, pos: Float32Array, side: 1 | -1, slack = 0.6) {
  let ext = -Infinity;
  for (let i = 2; i < pos.length; i += 3) ext = Math.max(ext, pos[i] * side);
  const f = { area: 0, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z: ext * side };
  eachTriangle(p, (a, b, c) => {
    const n = triNormal(pos, a, b, c);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 0) || Math.abs(n[2]) / l < 0.985) return;
    const z = ((pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3) * side;
    if (z < ext - slack) return;
    f.area += l / 2;
    for (const v of [a, b, c]) {
      const x = pos[v * 3], y = pos[v * 3 + 1];
      if (x < f.x0) f.x0 = x;
      if (x > f.x1) f.x1 = x;
      if (y < f.y0) f.y0 = y;
      if (y > f.y1) f.y1 = y;
    }
  });
  return f;
}

const hasNode = (p: PartInput, name: string) => p.nodeNames.includes(name);
const anyName = (p: PartInput, re: RegExp) => p.nodeNames.some((n) => re.test(n)) || p.otherNames.some((n) => re.test(n));
const quote = (p: PartInput, re: RegExp) => `"${[...p.nodeNames, ...p.otherNames].find((n) => re.test(n)) ?? ''}"`;

/** True when every documented node is there (the four arms or the single rocker for the D-pad). */
export function hasContract(parts: PartInput[]): boolean {
  const has = (n: string) => parts.some((p) => hasNode(p, n));
  const arms = Object.values(DPAD_ARM_NODES).every(has);
  return REQUIRED_NODES.every(has) && (arms || has(DPAD_ROCKER_NODE));
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ------------------------------------------------------------------ analyse
export function analyse(parts: PartInput[], g: DeviceGeometry): Analysis {
  const warnings: string[] = [];
  if (!parts.length) throw new Error('The file has no meshes.');
  const trusted = hasContract(parts);

  // ---- 1. frame: axes, size, centre
  let R: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // rows: device X, Y, Z in world coordinates
  let scale = 1;
  let centre: V3 = [0, 0, 0];
  if (!trusted) {
    const axes = principalAxes(parts);
    const ext = axes.map((ax) => {
      let lo = Infinity, hi = -Infinity;
      for (const p of parts)
        for (let i = 0; i < p.positions.length; i += 3) {
          const d = p.positions[i] * ax[0] + p.positions[i + 1] * ax[1] + p.positions[i + 2] * ax[2];
          if (d < lo) lo = d;
          if (d > hi) hi = d;
        }
      return hi - lo;
    });
    const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a]); // longest, middle, shortest
    const Z = axes[order[2]];
    let X = axes[order[1]];
    X = norm([X[0] - dot(X, Z) * Z[0], X[1] - dot(X, Z) * Z[1], X[2] - dot(X, Z) * Z[2]]);
    const Y = cross(Z, X);
    R = [X, Y, Z];
    const w = ext[order[1]], h = ext[order[0]];
    if (!(w > 0) || !(h > 0)) throw new Error('The model is flat or empty: its size cannot be measured.');
    scale = Math.sqrt((g.width / w) * (g.height / h));
    const ratio = w / h / (g.width / g.height);
    if (Math.abs(ratio - 1) > 0.06) warnings.push(`Proportions differ from the device (width/height is ${(w / h).toFixed(3)}, expected ${(g.width / g.height).toFixed(3)}): parts may be misplaced.`);
  }
  const place = (flipZ: boolean, flipY: boolean): Float32Array[] =>
    parts.map((p) => {
      const out = new Float32Array(p.positions.length);
      for (let i = 0; i < out.length; i += 3) {
        const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
        let dx = (x * R[0][0] + y * R[0][1] + z * R[0][2]) * scale - centre[0];
        let dy = (x * R[1][0] + y * R[1][1] + z * R[1][2]) * scale - centre[1];
        let dz = (x * R[2][0] + y * R[2][1] + z * R[2][2]) * scale - centre[2];
        if (flipZ) { dx = -dx; dz = -dz; } // half a turn about Y
        if (flipY) { dx = -dx; dy = -dy; } // half a turn about Z
        out[i] = dx; out[i + 1] = dy; out[i + 2] = dz;
      }
      return out;
    });
  let pos = place(false, false);
  const boundsOf = (ps: Float32Array[]) => {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const a of ps)
      for (let i = 0; i < a.length; i += 3)
        for (let k = 0; k < 3; k++) {
          if (a[i + k] < min[k]) min[k] = a[i + k];
          if (a[i + k] > max[k]) max[k] = a[i + k];
        }
    return { min, max };
  };
  if (!trusted) {
    const b = boundsOf(pos);
    centre = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    pos = place(false, false);
  }

  // ---- 2. which way is the front, which way is up
  let flipZ = false, flipY = false;
  let screenPart: number | null = null;
  let screenHow: How | 'overlay' = 'overlay';
  const named = parts.map((p, i) => (hasNode(p, 'screen') ? { i, how: 'node' as How } : anyName(p, SCREEN_WORDS) ? { i, how: 'name' as How } : null)).filter((x) => x !== null);
  const bodyLike = (i: number) => {
    const d = describe(parts[i], pos[i]);
    return d.max[0] - d.min[0] > 0.85 * g.width && d.max[1] - d.min[1] > 0.85 * g.height;
  };
  if (named.length) {
    // the largest flat one of the best tier
    const tier = named.some((n) => n.how === 'node') ? 'node' : 'name';
    let best = -1, bestArea = -1;
    for (const n of named) {
      if (n.how !== tier) continue;
      const a = describe(parts[n.i], pos[n.i]).flat.area;
      if (a > bestArea) { bestArea = a; best = n.i; }
    }
    screenPart = best;
    screenHow = tier;
    const d = describe(parts[best], pos[best]);
    if (!trusted) flipZ = (d.min[2] + d.max[2]) / 2 < 0;
  } else if (!trusted) {
    // a large flat surface on one of the two big faces: dark ones first, then anything that is not the body itself
    const b = boundsOf(pos);
    let best = { score: 0, i: -1, side: 1 as 1 | -1 };
    parts.forEach((p, i) => {
      if (bodyLike(i)) return;
      for (const side of [1, -1] as const) {
        const f = outerFlat(p, pos[i], side);
        const w = f.x1 - f.x0, h = f.y1 - f.y0;
        if (f.area < 0.25 * g.screen.w * g.screen.h || w < 0.6 * g.screen.w || h < 0.6 * g.screen.h) continue;
        if (Math.abs(f.z - (side > 0 ? b.max[2] : b.min[2])) > 4) continue; // must lie on the outside
        const dark = !p.textured && 0.2126 * p.color[0] + 0.7152 * p.color[1] + 0.0722 * p.color[2] < 0.08;
        const score = f.area * (dark ? 4 : 1);
        if (score > best.score) best = { score, i, side };
      }
    });
    if (best.i >= 0) {
      screenPart = best.i;
      screenHow = 'heuristic';
      flipZ = best.side < 0;
    } else warnings.push('No screen surface found: the front is assumed to be the side facing +Z of the file.');
  }
  if (!trusted) {
    if (flipZ) pos = place(true, false);
    let cy: number | null = null;
    if (screenPart !== null) {
      const f = outerFlat(parts[screenPart], pos[screenPart], 1);
      cy = f.area > 0 ? (f.y0 + f.y1) / 2 : (describe(parts[screenPart], pos[screenPart]).min[1] + describe(parts[screenPart], pos[screenPart]).max[1]) / 2;
    } else {
      const ctl = parts.map((p, i) => (anyName(p, CONTROL_WORDS) ? i : -1)).filter((i) => i >= 0);
      if (ctl.length) {
        let s = 0;
        for (const i of ctl) { const d = describe(parts[i], pos[i]); s -= (d.min[1] + d.max[1]) / 2; }
        cy = s;
      }
    }
    if (cy !== null && cy < 0) {
      flipY = true;
      pos = place(flipZ, true);
    } else if (cy === null) warnings.push('Could not tell the top from the bottom: the file\'s own up direction is kept.');
  }
  const bounds = boundsOf(pos);
  const desc = parts.map((p, i) => describe(p, pos[i]));

  // ---- 3. screen: where the picture goes
  let frontZ = bounds.max[2] - 1.1;
  let surface: Analysis['screen']['surface'] = 'none';
  let rect = { cx: g.screen.cx, cy: g.screen.cy, w: g.screen.w, h: g.screen.h, z: frontZ };
  if (screenPart !== null) {
    const f = outerFlat(parts[screenPart], pos[screenPart], 1);
    const d = desc[screenPart];
    const box = f.area > 0 ? f : { x0: d.min[0], x1: d.max[0], y0: d.min[1], y1: d.max[1], z: d.max[2] };
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    frontZ = box.z;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.08;
    if (near(w, g.screen.w) && near(h, g.screen.h)) rect = { cx, cy, w, h, z: frontZ };
    else if (screenHow === 'node' && w <= g.glass.w * 1.02 && h <= g.glass.h * 1.02) rect = { cx, cy, w, h, z: frontZ }; // the documented node is the picture, whatever its exact size
    else {
      // larger than the picture (the glass with its black border, usually): the picture keeps the device's own size, centred
      const k = Math.min(1, (w * 0.9) / g.screen.w, (h * 0.9) / g.screen.h);
      rect = { cx, cy, w: g.screen.w * k, h: g.screen.h * k, z: frontZ };
    }
    // is the part more than the picture (a glass with a border, or a slab with sides)? then it stays, as the glass under the picture
    surface = d.max[0] - d.min[0] > rect.w + 1 || d.max[1] - d.min[1] > rect.h + 1 ? 'glass' : 'picture';
    const what = screenHow === 'node' ? 'node "screen"' : screenHow === 'name' ? `name ${quote(parts[screenPart], SCREEN_WORDS)}` : 'shape (largest flat surface on a big face)';
    warnings.push(`Screen: matched by ${what}${surface === 'glass' ? `; that part is ${(d.max[0] - d.min[0]).toFixed(1)} x ${(d.max[1] - d.min[1]).toFixed(1)} mm, larger than the picture, so it stays as the glass and the picture (${rect.w.toFixed(1)} x ${rect.h.toFixed(1)} mm) sits on it` : ''}.`);
  } else warnings.push('Screen: not found, the picture is laid over the front at the device\'s own position.');

  // ---- 4. controls
  const controls: Analysis['controls'] = {};
  const taken = new Set<number>();
  if (screenPart !== null) taken.add(screenPart);
  const whole = (ids: number[], how: How): ControlMatch => {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const i of ids) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], desc[i].min[k]); max[k] = Math.max(max[k], desc[i].max[k]); }
    ids.forEach((i) => taken.add(i));
    return { how, pieces: ids.map((part) => ({ part, triangles: null })), x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: max[2] };
  };
  const nodeFor: [ControlId, string][] = [['top', 'btn_top'], ['bottom', 'btn_bottom'], ['dpad', DPAD_ROCKER_NODE], ['up', 'dpad_up'], ['down', 'dpad_down'], ['left', 'dpad_left'], ['right', 'dpad_right']];
  for (const [id, node] of nodeFor) {
    const ids = parts.map((p, i) => (hasNode(p, node) ? i : -1)).filter((i) => i >= 0);
    if (ids.length) controls[id] = whole(ids, 'node');
  }
  const haveDpad = () => !!controls.dpad || (!!controls.up && !!controls.down && !!controls.left && !!controls.right);
  if (!controls.top || !controls.bottom || !haveDpad()) {
    const m = 1.6;
    const region = (x: number, y: number): 'top' | 'bottom' | 'dpad' | null => {
      const dt = Math.hypot(x - g.top.x, y - g.top.y), db = Math.hypot(x - g.bottom.x, y - g.bottom.y);
      if (dt <= g.top.r + m || db <= g.bottom.r + m) return dt <= db ? 'top' : 'bottom';
      if (Math.abs(x - g.dpad.x) <= g.dpad.half + m && Math.abs(y - g.dpad.y) <= g.dpad.half + m) return 'dpad';
      return null;
    };
    const found: Record<'top' | 'bottom' | 'dpad', { pieces: Piece[]; named: boolean; min: V3; max: V3 }> = {
      top: { pieces: [], named: false, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
      bottom: { pieces: [], named: false, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
      dpad: { pieces: [], named: false, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    };
    parts.forEach((p, i) => {
      if (taken.has(i)) return;
      const d = desc[i];
      const isNamed = anyName(p, CONTROL_WORDS);
      if (d.max[0] - d.min[0] > 36 || d.max[1] - d.min[1] > 36 || d.max[2] - d.min[2] > 14) return; // far too big to be a control
      if (d.max[2] < frontZ - (isNamed ? 2.5 : 0.6)) return; // does not reach the front
      const a = pos[i];
      const lists: Record<'top' | 'bottom' | 'dpad', number[]> = { top: [], bottom: [], dpad: [] };
      const hidden: number[] = [];
      let stray = false;
      eachTriangle(p, (v0, v1, v2, t) => {
        if (stray) return;
        // what lies under the front surface (skirts, tabs, stems) is not looked at: it goes with the nearest control
        if ((a[v0 * 3 + 2] + a[v1 * 3 + 2] + a[v2 * 3 + 2]) / 3 < frontZ - 0.5) return void hidden.push(t);
        const r = region((a[v0 * 3] + a[v1 * 3] + a[v2 * 3]) / 3, (a[v0 * 3 + 1] + a[v1 * 3 + 1] + a[v2 * 3 + 1]) / 3);
        if (!r) stray = true;
        else lists[r].push(t);
      });
      if (stray) return;
      const seen = (['top', 'bottom', 'dpad'] as const).filter((k) => lists[k].length);
      if (!seen.length) return;
      const centreOf = { top: g.top, bottom: g.bottom, dpad: g.dpad };
      for (const t of hidden) {
        const i0 = p.indices ? p.indices[t * 3] : t * 3, i1 = p.indices ? p.indices[t * 3 + 1] : t * 3 + 1, i2 = p.indices ? p.indices[t * 3 + 2] : t * 3 + 2;
        const x = (a[i0 * 3] + a[i1 * 3] + a[i2 * 3]) / 3, y = (a[i0 * 3 + 1] + a[i1 * 3 + 1] + a[i2 * 3 + 1]) / 3;
        let best = seen[0], bd = Infinity;
        for (const k of seen) {
          const d2 = Math.hypot(x - centreOf[k].x, y - centreOf[k].y);
          if (d2 < bd) { bd = d2; best = k; }
        }
        lists[best].push(t);
      }
      const used = seen;
      for (const k of used) {
        const f = found[k];
        const tris = used.length === 1 ? null : new Uint32Array(lists[k]);
        f.pieces.push({ part: i, triangles: tris });
        f.named ||= isNamed;
        // extent of this piece
        const pick = tris ? new Set(tris) : null;
        eachTriangle(p, (v0, v1, v2, t) => {
          if (pick && !pick.has(t)) return;
          for (const v of [v0, v1, v2]) for (let c = 0; c < 3; c++) { f.min[c] = Math.min(f.min[c], a[v * 3 + c]); f.max[c] = Math.max(f.max[c], a[v * 3 + c]); }
        });
      }
    });
    const accept = (k: 'top' | 'bottom' | 'dpad') => {
      const f = found[k];
      if (!f.pieces.length || (k !== 'dpad' && controls[k]) || (k === 'dpad' && haveDpad())) return;
      const size = Math.max(f.max[0] - f.min[0], f.max[1] - f.min[1]);
      if (size < (k === 'dpad' ? 12 : 3)) return;
      f.pieces.forEach((pc) => taken.add(pc.part));
      controls[k] = { how: f.named ? 'name' : 'position', pieces: f.pieces, x: (f.min[0] + f.max[0]) / 2, y: (f.min[1] + f.max[1]) / 2, z: f.max[2] };
    };
    accept('top');
    accept('bottom');
    accept('dpad');
  }
  const say = (label: string, c: ControlMatch | undefined, extra = '') => {
    if (!c) return warnings.push(`${label}: no separate mesh found; it stays clickable through an invisible target but does not move.`);
    const split = c.pieces.some((p) => p.triangles) ? ' (cut out of a mesh shared with another control)' : '';
    warnings.push(`${label}: matched by ${c.how === 'node' ? 'node name' : c.how === 'name' ? 'a name containing a control word, and its position' : 'position and size'}${split}${extra}.`);
  };
  say('Top button', controls.top);
  say('Bottom button', controls.bottom);
  if (controls.up && controls.down && controls.left && controls.right) warnings.push('D-pad: four arms matched by node name.');
  else say('D-pad', controls.dpad, controls.dpad ? '; one mesh, so it rocks as a whole with four press zones' : '');

  // ---- 5. light guide
  let led: Analysis['led'] = null;
  const free = (i: number) => !taken.has(i);
  const byNode = parts.map((p, i) => (hasNode(p, 'led') ? i : -1)).filter((i) => i >= 0);
  if (byNode.length) led = { how: 'node', parts: byNode };
  else {
    const byName = parts.map((p, i) => (free(i) && anyName(p, LED_WORDS) ? i : -1)).filter((i) => i >= 0);
    if (byName.length) led = { how: 'name', parts: byName };
    else {
      const glow = parts
        .map((p, i) => {
          const d = desc[i];
          const cx = (d.min[0] + d.max[0]) / 2, cy = (d.min[1] + d.max[1]) / 2;
          return free(i) && p.emissive && Math.hypot(cx - g.led.x, cy - g.led.y) < 9 && d.max[2] > frontZ - 3 && d.max[0] - d.min[0] < 15 && d.max[1] - d.min[1] < 15 ? i : -1;
        })
        .filter((i) => i >= 0);
      if (glow.length) led = { how: 'heuristic', parts: glow };
    }
  }
  warnings.push(led ? `LED: matched by ${led.how === 'node' ? 'node "led"' : led.how === 'name' ? 'name' : 'a glowing part in the top right corner'}.` : 'LED: no light-guide part found; a small overlay in the top right corner shows it.');

  // ---- matrix (column-major): device = F * (s * R * world - centre)
  let matrix = IDENTITY.slice();
  if (!trusted) {
    const sx = (flipZ ? -1 : 1) * (flipY ? -1 : 1), sy = flipY ? -1 : 1, sz = flipZ ? -1 : 1;
    const sg = [sx, sy, sz];
    matrix = [];
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) matrix.push(sg[r] * scale * R[r][c]);
      matrix.push(0);
    }
    matrix.push(-sx * centre[0], -sy * centre[1], -sz * centre[2], 1);
  }
  return { matrix, trusted, scale, frontZ, bounds, screen: { how: screenHow, part: screenPart, surface, rect }, controls, led, warnings };
}

/** Applies a column-major 4x4 to xyz triples. */
export function transformPoints(m: ArrayLike<number>, positions: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < out.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Which D-pad arm a point is on, given offsets from the pad centre in mm (x right, y up); null in the dead centre. */
export function armAt(dx: number, dy: number, dead = 0.6): 'up' | 'down' | 'left' | 'right' | null {
  if (Math.hypot(dx, dy) < dead) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy > 0 ? 'up' : 'down';
}
