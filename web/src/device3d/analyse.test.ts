import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SPEC } from '../lib/geometry';
import { bodyDims } from '../lib/bodyModel';
import { analyse, armAt, eigenSymmetric3, geometryFromSpec, hasContract, principalAxes, transformPoints, type PartInput } from './analyse';
import { validateGlb, MAX_MODEL_BYTES } from './customModel';
import { partsFromScene, prepareScene } from './prepare';
import { makeTestGlb, testDevice, type TestGlbOptions } from './testGlb';

const G = geometryFromSpec(SPEC);
const D = bodyDims();

async function load(buffer: ArrayBuffer) {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}
/** unit quaternion for a rotation of `deg` about `axis` */
function quat(axis: [number, number, number], deg: number): [number, number, number, number] {
  const l = Math.hypot(...axis), s = Math.sin((deg * Math.PI) / 360);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos((deg * Math.PI) / 360)];
}
/** q2 * q1 */
function mul(a: number[], b: number[]): [number, number, number, number] {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
// as the maker's file: metres, y pointing down the device, front towards -z, then tilted
const CAD: TestGlbOptions = { rotation: mul(quat([0.3, 1, 0.2], 37), quat([1, 0, 0], 180)), scale: 0.001, translation: [0.4, -0.1, 0.25], onNodes: true };

describe('geometry from the data', () => {
  it('agrees with the model dimensions used everywhere else', () => {
    expect(G.width).toBeCloseTo(D.hw * 2, 9);
    expect(G.height).toBeCloseTo(D.hh * 2, 9);
    expect(G.screen.w).toBeCloseTo(D.screen.w, 9);
    expect(G.screen.cy).toBeCloseTo(D.screen.cy, 9);
    expect(G.glass.w).toBeCloseTo(D.bezel.w, 9);
    expect(G.glass.h).toBeCloseTo(D.bezel.h, 9);
    expect(G.top.x).toBeCloseTo(D.buttons.top.x, 9);
    expect(G.bottom.y).toBeCloseTo(D.buttons.bottom.y, 9);
    expect(G.dpad.half).toBeCloseTo(D.dpad.half, 9);
    expect(G.led.x).toBeGreaterThan(15);
    expect(G.led.y).toBeGreaterThan(30);
  });
});

describe('maths', () => {
  it('eigenSymmetric3 diagonalises', () => {
    const { values, vectors } = eigenSymmetric3([[4, 1, 0], [1, 3, 0], [0, 0, 9]]);
    for (let k = 0; k < 3; k++) {
      const v = vectors[k];
      const mv = [4 * v[0] + v[1], v[0] + 3 * v[1], 9 * v[2]];
      for (let c = 0; c < 3; c++) expect(mv[c]).toBeCloseTo(values[k] * v[c], 9);
    }
  });
  it('principalAxes recovers the axes of a tilted box to a hundredth of a degree', async () => {
    const q = quat([1, 2, 3], 71);
    const scene = await load(makeTestGlb([{ name: 'box', boxes: [{ c: [0, 0, 0], s: [46.65, 77, 19.5] }] }], { rotation: q }));
    const axes = principalAxes(partsFromScene(scene).map((p) => p.input));
    const want = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => {
      const [x, y, z, w] = q;
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
    });
    for (const w of want) {
      const best = Math.max(...axes.map((a) => Math.abs(a[0] * w[0] + a[1] * w[1] + a[2] * w[2])));
      expect(Math.acos(Math.min(1, best)) * (180 / Math.PI)).toBeLessThan(0.01);
    }
  });
  it('armAt picks the arm, with a dead centre', () => {
    expect(armAt(0, 5)).toBe('up');
    expect(armAt(0, -5)).toBe('down');
    expect(armAt(-5, 1)).toBe('left');
    expect(armAt(5, -1)).toBe('right');
    expect(armAt(0.1, 0.1)).toBeNull();
  });
});

describe('a file that follows the documented node names', () => {
  it('is trusted as it is: nothing moves, every part comes from its node', async () => {
    const scene = await load(makeTestGlb(testDevice('contract')));
    const parts = partsFromScene(scene).map((p) => p.input);
    expect(hasContract(parts)).toBe(true);
    const a = analyse(parts, G);
    expect(a.trusted).toBe(true);
    expect(a.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(a.screen.how).toBe('node');
    expect(a.screen.surface).toBe('picture');
    expect(a.screen.rect.w).toBeCloseTo(33.09, 2);
    expect(a.screen.rect.h).toBeCloseTo(40.52, 2);
    expect(a.screen.rect.cy).toBeCloseTo(11.21, 2);
    for (const id of ['top', 'bottom', 'up', 'down', 'left', 'right'] as const) expect(a.controls[id]?.how).toBe('node');
    expect(a.controls.top!.pieces.length).toBe(1); // only what is under the node: the unnamed inlay beside it stays static
    expect(a.controls.dpad).toBeUndefined();
    expect(a.led?.how).toBe('node');
  });
  it('accepts a single "dpad" node as a rocker', async () => {
    const scene = await load(makeTestGlb(testDevice('contract', { rockerDpad: true })));
    const a = analyse(partsFromScene(scene).map((p) => p.input), G);
    expect(a.trusted).toBe(true);
    expect(a.controls.dpad?.how).toBe('node');
    expect(a.controls.dpad!.x).toBeCloseTo(G.dpad.x, 2);
  });
});

describe('a CAD export: tilted, in metres, upside down, CAD feature names', () => {
  it('is brought into the device frame', async () => {
    const scene = await load(makeTestGlb(testDevice('cad', { joinedButtons: true }), CAD));
    const src = partsFromScene(scene);
    const a = analyse(src.map((p) => p.input), G);
    expect(a.trusted).toBe(false);
    expect(a.scale).toBeCloseTo(1000, 0);
    // the body ends up centred, 46.65 x 77 mm, 19.5 deep plus the controls standing proud
    expect(a.bounds.min[0]).toBeCloseTo(-G.width / 2, 2);
    expect(a.bounds.max[0]).toBeCloseTo(G.width / 2, 2);
    expect(a.bounds.min[1]).toBeCloseTo(-G.height / 2, 2);
    expect(a.bounds.max[1]).toBeCloseTo(G.height / 2, 2);
    // every part lands where it was built (the generator's frame is the device frame, up to the z centring)
    const body = transformPoints(a.matrix, src[0].world);
    let maxZ = -Infinity;
    for (let i = 2; i < body.length; i += 3) maxZ = Math.max(maxZ, body[i]);
    expect(a.frontZ).toBeCloseTo(maxZ, 2); // glass flush with the front of the body
    expect(a.screen.how).toBe('name');
    expect(a.screen.surface).toBe('glass');
    expect(a.screen.rect.cx).toBeCloseTo(0, 2);
    expect(a.screen.rect.cy).toBeCloseTo(11.21, 2);
    expect(a.screen.rect.w).toBeCloseTo(G.screen.w, 6); // the picture keeps its own size on the larger glass
    expect(a.screen.rect.h).toBeCloseTo(G.screen.h, 6);
  });
  it('finds the controls by name and place, cutting the two buttons out of their shared mesh', async () => {
    const scene = await load(makeTestGlb(testDevice('cad', { joinedButtons: true }), CAD));
    const a = analyse(partsFromScene(scene).map((p) => p.input), G);
    const { top, bottom, dpad } = a.controls;
    expect(top?.how).toBe('name');
    expect(bottom?.how).toBe('name');
    expect(dpad?.how).toBe('name');
    expect(top!.x).toBeCloseTo(G.top.x, 1);
    expect(top!.y).toBeCloseTo(G.top.y, 1);
    expect(bottom!.x).toBeCloseTo(G.bottom.x, 1);
    expect(bottom!.y).toBeCloseTo(G.bottom.y, 1);
    expect(dpad!.x).toBeCloseTo(G.dpad.x, 1);
    expect(dpad!.y).toBeCloseTo(G.dpad.y, 1);
    // one box (12 triangles) each from the shared mesh, plus the inlay on the top one
    const shared = top!.pieces.find((p) => p.triangles)!;
    expect(shared.triangles!.length).toBe(12);
    expect(bottom!.pieces[0].part).toBe(shared.part);
    expect(bottom!.pieces[0].triangles!.length).toBe(12);
    expect(top!.pieces.length).toBe(2);
    expect(a.led?.how).toBe('heuristic');
    expect(a.warnings.join('\n')).toMatch(/Screen: matched by name "screen 1"/);
    expect(a.warnings.join('\n')).toMatch(/cut out of a mesh shared/);
  });
});

describe('a file with no telling names at all', () => {
  const variants: [string, TestGlbOptions][] = [
    ['as modelled', {}],
    ['tilted, scaled, moved (baked into the vertices)', { rotation: quat([2, -1, 0.5], 143), scale: 0.0254, translation: [3, 4, -5] }],
    ['upside down and back to front', { rotation: mul(quat([0, 0, 1], 180), quat([0, 1, 0], 180)) }],
  ];
  for (const [label, opts] of variants)
    it(`${label}: screen by shape, controls by position, LED by its glow`, async () => {
      const scene = await load(makeTestGlb(testDevice('none'), opts));
      const a = analyse(partsFromScene(scene).map((p) => p.input), G);
      expect(a.screen.how).toBe('heuristic');
      expect(a.screen.rect.cy).toBeCloseTo(11.21, 1);
      expect(a.screen.rect.cx).toBeCloseTo(0, 1);
      expect(a.controls.top?.how).toBe('position');
      expect(a.controls.bottom?.how).toBe('position');
      expect(a.controls.dpad?.how).toBe('position');
      expect(a.controls.top!.x).toBeCloseTo(G.top.x, 1);
      expect(a.controls.bottom!.y).toBeCloseTo(G.bottom.y, 1);
      expect(a.controls.dpad!.x).toBeCloseTo(G.dpad.x, 1);
      expect(a.led?.how).toBe('heuristic');
      expect(a.bounds.max[1] - a.bounds.min[1]).toBeCloseTo(G.height, 1);
    });
  it('a bare body: nothing is found, everything falls back to overlays, with warnings saying so', async () => {
    const scene = await load(makeTestGlb([{ name: 'thing', boxes: [{ c: [0, 0, 0], s: [46.65, 77, 19.5] }] }]));
    const a = analyse(partsFromScene(scene).map((p) => p.input), G);
    expect(a.screen.how).toBe('overlay');
    expect(a.screen.rect.w).toBeCloseTo(G.screen.w, 6);
    expect(a.controls).toEqual({});
    expect(a.led).toBeNull();
    const text = a.warnings.join('\n');
    expect(text).toMatch(/Screen: not found/);
    expect(text).toMatch(/Top button: no separate mesh/);
    expect(text).toMatch(/D-pad: no separate mesh/);
    expect(text).toMatch(/LED: no light-guide part/);
  });
  it('warns when the proportions are not the device\'s', async () => {
    const scene = await load(makeTestGlb([{ name: 'slab', boxes: [{ c: [0, 0, 0], s: [60, 77, 10] }] }]));
    const a = analyse(partsFromScene(scene).map((p) => p.input), G);
    expect(a.warnings.join('\n')).toMatch(/Proportions differ/);
  });
  it('refuses nothing', () => {
    expect(() => analyse([], G)).toThrow(/no meshes/);
    const flat: PartInput = { nodeNames: [], otherNames: [], positions: [0, 0, 0, 0, 0, 0, 0, 0, 0], indices: null, color: [1, 1, 1], textured: false, emissive: false };
    expect(() => analyse([flat], G)).toThrow(/flat or empty/);
  });
});

describe('prepared model (what the 3D view gets)', () => {
  it('CAD export: one draw call per material for the static parts, groups for the controls, picture rect, hit targets', async () => {
    const scene = await load(makeTestGlb(testDevice('cad', { joinedButtons: true }), CAD));
    const m = await prepareScene(scene);
    expect(m.press.top?.name).toBe('btn_top');
    expect(m.press.bottom?.name).toBe('btn_bottom');
    expect(m.rocker?.name).toBe('dpad');
    expect(m.rocker!.position.x).toBeCloseTo(G.dpad.x, 1);
    expect(m.glass.length).toBe(1); // the larger glass stays, under the picture
    expect(m.led.length).toBe(1);
    expect(m.screen.w).toBeCloseTo(G.screen.w, 6);
    expect(m.hit.top[0]).toBeCloseTo(G.top.x, 1);
    expect(m.hit.dpad[1]).toBeCloseTo(G.dpad.y, 1);
    expect(m.hit.top[2]).toBeGreaterThan(m.analysis.frontZ);
    // body + pcb stay static (two materials); buttons were cut in two
    expect(m.stats.sourceMeshes).toBe(7);
    expect(m.stats.sourceTriangles).toBe(12 * 9);
    expect(m.stats.triangles).toBe(12 * 9);
    let top = 0;
    m.press.top!.traverse((o) => { const g = (o as { geometry?: { index: { count: number } } }).geometry; if (g) top += g.index.count / 3; });
    expect(top).toBe(24); // its half of the shared mesh, and the inlay
    m.dispose();
  });
  it('performance mode merges parts whose materials become equal; raw mode keeps the file as it is', async () => {
    const same: [number, number, number] = [0.5, 0.5, 0.5];
    const boxes = [0, 1, 2, 3].map((i) => ({ name: `part${i}`, colour: same, boxes: [{ c: [i * 5 - 7.5, 20, 0] as [number, number, number], s: [4, 4, 4] as [number, number, number] }] }));
    const file = makeTestGlb([...testDevice('contract'), ...boxes]);
    const fast = await prepareScene(await load(file));
    const raw = await prepareScene(await load(file), { raw: true });
    expect(raw.stats.drawCalls).toBe(raw.stats.sourceMeshes - 1); // all but the hidden picture surface
    expect(fast.stats.drawCalls).toBeLessThanOrEqual(raw.stats.drawCalls - 3);
    expect(fast.stats.triangles).toBe(raw.stats.triangles);
    expect(fast.press.up && fast.press.down && fast.press.left && fast.press.right).toBeTruthy();
    expect(fast.rocker).toBeNull();
  });
});

describe('validateGlb', () => {
  it('accepts a real GLB and explains what is wrong with anything else', () => {
    expect(validateGlb(makeTestGlb(testDevice('contract')))).toBeNull();
    expect(validateGlb(new TextEncoder().encode('<!doctype html><html></html>').buffer as ArrayBuffer)).toMatch(/not a GLB/);
    expect(validateGlb(new ArrayBuffer(4))).toMatch(/too short/);
    const cut = makeTestGlb(testDevice('contract')).slice(0, 200);
    expect(validateGlb(cut)).toMatch(/cut short|damaged/);
    expect(validateGlb(makeTestGlb(testDevice('contract'), { extensionsRequired: ['KHR_texture_basisu'] }))).toMatch(/KHR_texture_basisu/);
    expect(validateGlb(makeTestGlb(testDevice('contract'), { extensionsRequired: ['KHR_draco_mesh_compression', 'EXT_texture_webp'] }))).toBeNull();
    expect(validateGlb(new ArrayBuffer(MAX_MODEL_BYTES + 1))).toMatch(/limit is 30\.0 MB/);
  });
});
