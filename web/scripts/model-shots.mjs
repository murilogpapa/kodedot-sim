// Renders the 3D model from the viewpoints of the reference pictures (plus a
// straight front, a top view and a few extras) into web/screenshots/model-*.png,
// on a plain #C2BAB3 background, and checks every shot automatically.
//
//   node scripts/model-shots.mjs                 the procedural ("simple") model: build, serve, shoot, check
//   node scripts/model-shots.mjs --kode [file]    the bundled model (public/device/model.glb, or the given optimised file)
//   node scripts/model-shots.mjs --custom <file>  a model loaded through the page's own store, as a user would (add --raw
//                                                 to show the file untouched, for "before" numbers)
//   node scripts/model-shots.mjs --glb            the documented node names, on a synthetic GLB made here
//   options: --no-build (reuse the last build), --shots <dir>, --page (run through the real page; simple model only),
//            a bare word (only the views whose name contains it)
//
// Where the pictures go: the simple model's to web/screenshots/model-*.png. Pictures of a model FILE go next to that
// file (<its folder>/shots/) unless --shots says otherwise, or the file is the repository's own bundled model
// (then web/screenshots/model-kode-*.png).
//
// It builds the "model stand" (src/device3d/harness: the same Device3D component, alone, with a stand-in device and a
// fixed test picture), so the shots do not depend on the rest of the page. It never touches web/dist: it builds into
// its own folder and serves on its own port, with the same cross-origin isolation headers and the same
// Content-Security-Policy as the deployed page (vercel.json).
import puppeteer from 'puppeteer-core';
import react from '@vitejs/plugin-react';
import { build as viteBuild, preview as vitePreview } from 'vite';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.MODEL_DIST ?? '/tmp/dotbench-model-dist';
const PORT = Number(process.env.MODEL_PORT ?? 4391);
const BG = [0xc2, 0xba, 0xb3];
const W = 760;
const H = 900;
const args = process.argv.slice(2);
/** --name value (the value is optional when `optional`): removes both from args. */
function option(name, optional = false) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  const has = next !== undefined && !next.startsWith('--') && (!optional || /[\\/.]/.test(next));
  args.splice(i, has ? 2 : 1);
  return has ? resolve(next) : optional ? '' : undefined;
}
const customFile = option('--custom');
const kodeFile = option('--kode', true);
const shotsArg = option('--shots');
const flags = new Set(args.filter((a) => a.startsWith('--')));
const only = args.find((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (d) => (d * Math.PI) / 180;

/**
 * Views. `rot` = model rotation in radians about X, Y, Z (applied as Rz*Rx*Ry);
 * the reference views come from cameras solved on the reference pictures.
 * `expect`: what must be visible (bezel = dark glass, blue/red = the inlays).
 */
const VIEWS = {
  'model-front-three-quarter': { rot: [-0.117, 0.663, 0.064], elevation: 0, expect: { bezel: true, blue: true, red: true } }, // ref-1, front unit
  'model-front-right': { rot: [0.393, -1.183, -0.199], elevation: 0, expect: { bezel: true, blue: true, red: true } }, // ref-2
  'model-left-edge': { rot: [0, deg(90), deg(6.8)], elevation: 0, expect: {} }, // ref-3
  'model-back': { rot: [-0.1, deg(-150), 0.064], elevation: 0, expect: {} }, // ref-1, back unit
  'model-front': { rot: [0, 0, 0], elevation: 0, expect: { bezel: true, blue: true, red: true } },
  'model-top': { rot: [deg(90), 0, 0], elevation: 0, zoom: 1.6, expect: {} },
  // extras
  'model-opening-view': { pose: null, elevation: 8, expect: { bezel: true, blue: true, red: true } }, // what the page shows first
  'model-back-straight': { rot: [0, deg(180), 0], elevation: 0, expect: {} },
  'model-rear-low': { rot: [deg(-28), deg(140), 0], elevation: 0, expect: {} }, // the taper at the bottom of the back
  'model-controls-close': { rot: [-0.25, 0.5, 0.05], elevation: 0, zoom: 1.9, offsetY: 0.3, close: true, expect: { blue: true, red: true } },
};

const PAGE = flags.has('--page');
const stand = join(root, 'src', 'device3d', 'harness');
// the deployed page's headers, so loaders are exercised under the real policy
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const isolation = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
const standConfig = {
  configFile: false,
  root: stand,
  publicDir: join(root, 'public'),
  plugins: [react()],
  // the stand must not drag the whole page in through the 2D view
  resolve: { alias: [{ find: /^\.\/Device2D$/, replacement: join(stand, 'device2dStub.ts') }] },
  build: { outDir: OUT, emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  preview: { port: PORT, strictPort: true, headers: isolation },
  logLevel: 'warn',
};

async function build() {
  if (PAGE) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('vite build failed');
  } else await viteBuild(standConfig);
}

async function serve() {
  if (PAGE) {
    const child = spawn('npx', ['vite', 'preview', '--outDir', OUT, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
    return () => child.kill();
  }
  const srv = await vitePreview(standConfig);
  return () => srv.httpServer.close();
}

/** Minimal binary glTF: a body box and one box per required node, millimetres, +Z towards the viewer. */
function syntheticGlb() {
  const box = (cx, cy, cz, sx, sy, sz) => {
    const p = [];
    const uv = [];
    const idx = [];
    const faces = [
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    ];
    const nrm = [];
    for (const [n, u, v] of faces) {
      const base = p.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        p.push(cx + (n[0] + a * u[0] + b * v[0]) * sx / 2, cy + (n[1] + a * u[1] + b * v[1]) * sy / 2, cz + (n[2] + a * u[2] + b * v[2]) * sz / 2);
        nrm.push(...n);
        uv.push((a + 1) / 2, (1 - b) / 2); // glTF: v runs down
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { p, nrm, uv, idx };
  };
  const parts = [
    ['body', box(0, 0, 0, 46.65, 77, 19.8), [0.9, 0.87, 0.8, 1]],
    ['screen', box(0, 11.21, 9.95, 33.09, 40.52, 0.1), [0, 0, 0, 1]],
    ['btn_top', box(12.95, -19.48, 10.5, 8, 8, 1.2), [0.01, 0.54, 0.76, 1]],
    ['btn_bottom', box(8.25, -30.78, 10.5, 8, 8, 1.2), [0.79, 0.19, 0.24, 1]],
    ['dpad_up', box(-8.25, -19.1, 10.5, 5.5, 5.5, 1.2), [0.1, 0.1, 0.1, 1]],
    ['dpad_down', box(-8.25, -31.1, 10.5, 5.5, 5.5, 1.2), [0.1, 0.1, 0.1, 1]],
    ['dpad_left', box(-14.25, -25.1, 10.5, 5.5, 5.5, 1.2), [0.1, 0.1, 0.1, 1]],
    ['dpad_right', box(-2.25, -25.1, 10.5, 5.5, 5.5, 1.2), [0.1, 0.1, 0.1, 1]],
    ['led', box(19, 34, 9.95, 4, 4, 0.2), [0.95, 0.93, 0.68, 1]],
  ];
  const chunks = [];
  let offset = 0;
  const views = [], accessors = [], meshes = [], nodes = [], materials = [];
  const push = (typed, target) => {
    const buf = Buffer.from(typed.buffer);
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf);
    offset += buf.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    return views.length - 1;
  };
  parts.forEach(([name, b, colour], i) => {
    const P = new Float32Array(b.p);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k++) { min[k % 3] = Math.min(min[k % 3], P[k]); max[k % 3] = Math.max(max[k % 3], P[k]); }
    const a0 = accessors.length;
    accessors.push({ bufferView: push(P, 34962), componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: push(new Float32Array(b.nrm), 34962), componentType: 5126, count: P.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: push(new Float32Array(b.uv), 34962), componentType: 5126, count: P.length / 3, type: 'VEC2' });
    accessors.push({ bufferView: push(new Uint16Array(b.idx), 34963), componentType: 5123, count: b.idx.length, type: 'SCALAR' });
    materials.push({ name, pbrMetallicRoughness: { baseColorFactor: colour, metallicFactor: 0, roughnessFactor: 0.7 } });
    meshes.push({ primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2 }, indices: a0 + 3, material: i }] });
    nodes.push({ name, mesh: i });
  });
  const json = { asset: { version: '2.0', generator: 'dotbench model-shots' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }] };
  let jb = Buffer.from(JSON.stringify(json));
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
  const bin = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, jb, bh, bin]);
}

/** Pixel statistics of a PNG, computed in the page (no image library needed). */
async function stats(page, png) {
  return page.evaluate(async (b64, bg) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let object = 0, dark = 0, blue = 0, red = 0, clipped = 0, cream = 0, sr = 0, sg = 0, sb = 0;
    const n = c.width * c.height;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (Math.abs(r - bg[0]) + Math.abs(gg - bg[1]) + Math.abs(b - bg[2]) > 14) object++;
      if (r + gg + b < 110) dark++;
      if (b > 150 && r < 90 && b - r > 110 && gg > 90) blue++;
      if (r > 150 && gg < 95 && b < 110 && r - gg > 90) red++;
      if (r > 251 && gg > 251 && b > 251) clipped++;
      if (r > 200 && gg > 190 && b > 170 && r >= gg && gg >= b && r - b < 60) { cream++; sr += r; sg += gg; sb += b; }
    }
    return { object: object / n, dark: dark / n, blue, red, clipped: clipped / n, cream: cream / n, creamMean: cream ? [sr / cream, sg / cream, sb / cream].map(Math.round) : null };
  }, Buffer.from(png).toString('base64'), BG);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const repoModel = join(root, 'public', 'device', 'model.glb');
const distModel = join(OUT, 'device', 'model.glb');

/** One visit: open the stand (or the page), get the wanted model on show, shoot the views, try the controls, measure. */
async function session(browser, base, o) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('dotbench.lang', '"en"'));
  const resp = await page.goto(`${base}/?debug${o.query ? '&' + o.query : ''}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid=webgl-canvas]', { timeout: 20000 });
  await page.waitForFunction(() => !!window.__dotbench3d, { timeout: 20000 });
  if (PAGE && !only) {
    // first, the model where it lives: the whole page at a laptop size
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await sleep(1500);
    writeFileSync(join(root, 'screenshots', 'model-in-page.png'), await page.screenshot({ type: 'png' }));
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  }
  // the stage alone, on the plain page colour (the stand already is). Through the CSSOM: the page's CSP forbids injected style sheets.
  if (PAGE)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid=device-3d]');
      const set = (k, v) => el.style.setProperty(k, v, 'important');
      set('position', 'fixed'); set('inset', '0'); set('z-index', '2147483647'); set('background', '#C2BAB3'); set('width', '100vw'); set('height', '100vh');
    });
  const h = resp.headers();
  check(`${o.label}: page is cross-origin isolated and carries the deployed Content-Security-Policy`, h['cross-origin-opener-policy'] === 'same-origin' && h['cross-origin-embedder-policy'] === 'require-corp' && (PAGE || /script-src 'self' blob: 'wasm-unsafe-eval'/.test(h['content-security-policy'] ?? '')));
  check(`${o.label}: a WebGL context exists`, await page.evaluate(() => {
    const c = document.querySelector('[data-testid=webgl-canvas]');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return !!gl && !gl.isContextLost();
  }));
  if (o.prepare) await o.prepare(page);
  if (!PAGE) {
    const shown = await page.waitForFunction((want) => window.__dotbench3d?.info().model === want, { timeout: 30000 }, o.model).then(() => true, () => false);
    check(`${o.label}: the ${o.model} model is on show`, shown, shown ? '' : JSON.stringify(await page.evaluate(() => ({ model: window.__dotbench3d.info().model, state: window.__stand.model.getState() }))));
    if (!shown) return null;
  }
  await sleep(1200);
  const size = await page.evaluate(() => { const r = document.querySelector('[data-testid=webgl-canvas]').getBoundingClientRect(); return [r.width, r.height]; });
  check(`${o.label}: stage fills the shot`, Math.abs(size[0] - W) < 2 && Math.abs(size[1] - H) < 2, size.join('x'));

  mkdirSync(o.dir, { recursive: true });
  for (const [name, v] of Object.entries(VIEWS)) {
    if (only && !name.includes(only)) continue;
    await page.evaluate((v) => window.__dotbench3d.setViewDebug({ rotationZXY: v.rot ?? null, elevationDeg: v.elevation ?? 8, zoom: v.zoom ?? 1, offsetY: v.offsetY ?? 0 }), v);
    await sleep(700);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    const file = name.replace(/^model-/, o.prefix);
    writeFileSync(join(o.dir, `${file}.png`), png);
    const s = await stats(page, png);
    const e = v.expect ?? {};
    check(`${file}: object covers a sensible share of the frame`, s.object > 0.1 && (v.close || s.object < 0.9), `object ${(s.object * 100).toFixed(1)}%`);
    check(`${file}: light body visible and not clipped`, s.cream > 0.03 && s.clipped < 0.02, `cream ${(s.cream * 100).toFixed(1)}% mean rgb ${s.creamMean} clipped ${(s.clipped * 100).toFixed(2)}%`);
    if (e.bezel) check(`${file}: dark glass bezel visible`, s.dark > 0.02, `dark ${(s.dark * 100).toFixed(1)}%`);
    if (e.blue && o.colours !== false) check(`${file}: blue inlay visible`, s.blue > 60, `${s.blue} px`);
    if (e.red && o.colours !== false) check(`${file}: red inlay visible`, s.red > 20, `${s.red} px`);
  }

  // ---- interaction: the contract with the page (controls, glass mapping), on the default view
  if (!only) {
    await page.evaluate(() => window.__dotbench3d.setViewDebug({ rotationZXY: null, elevationDeg: 8, zoom: 1, offsetY: 0 }));
    await sleep(500);
    const events = () => page.evaluate(() => (window.__stand ? window.__stand.events.join('\n') : document.body.innerText));
    const ledNow = () => page.evaluate(() => (window.__stand ? JSON.stringify(window.__stand.led()) : document.querySelector('[data-testid=led]')?.getAttribute('data-color')));
    const at = (spec) => page.evaluate((q) => window.__dotbench3d.project(q), spec);
    const crop = async (c) => Buffer.from(await page.screenshot({ type: 'png', clip: { x: Math.round(c.x - 40), y: Math.round(c.y - 40), width: 80, height: 80 } })).toString('base64');
    const pressed = () => page.evaluate(() => window.__dotbench3d.pressed());
    if (!PAGE) {
      // the live picture is on the glass: the stand's test picture has an orange disc centred at (265, 420)
      await page.evaluate(() => window.__dotbench3d.setViewDebug({ rotationZXY: [0, 0, 0], elevationDeg: 0 }));
      await sleep(400);
      const c = await at('glass:300,470');
      const px = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = cv.height = 3;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        return [...g.getImageData(1, 1, 1, 1).data].slice(0, 3);
      }, Buffer.from(await page.screenshot({ type: 'png', clip: { x: Math.round(c.x) - 1, y: Math.round(c.y) - 1, width: 3, height: 3 } })).toString('base64'));
      check(`${o.label}: the live picture shows on the screen, in its true colour`, Math.abs(px[0] - 0xe7) < 12 && Math.abs(px[1] - 0xa2) < 12 && Math.abs(px[2] - 0x3a) < 14, `rgb ${px} (drawn as 231,162,58)`);
      await page.evaluate(() => window.__dotbench3d.setViewDebug({ rotationZXY: null, elevationDeg: 8 }));
      await sleep(400);
    }
    const l0 = await ledNow();
    const top = await at('top');
    const rest = await crop(top);
    await page.mouse.move(top.x, top.y);
    await page.mouse.down();
    await sleep(350);
    const held = await crop(top);
    const heldIds = await pressed();
    await page.mouse.up();
    await sleep(250);
    check(`${o.label}: holding the top button presses "top", releasing lets go`, heldIds.join() === 'top' && (await pressed()).length === 0, `held: [${heldIds}]`);
    if (o.moves?.top !== false) check(`${o.label}: the top button visibly moves while held`, rest !== held);
    if (!PAGE) check(`${o.label}: the press reaches the device (stand-in LED changes)`, (await ledNow()) !== l0, `${l0} -> ${await ledNow()}`);
    for (const [spec, id] of [['bottom', 'bottom'], ['dpad:up', 'up'], ['dpad:down', 'down'], ['dpad:left', 'left'], ['dpad:right', 'right']]) {
      const c = await at(spec);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await sleep(120);
      const ids = await pressed();
      await page.mouse.up();
      await sleep(80);
      check(`${o.label}: ${spec} holds "${id}" only`, ids.join() === id, `held: [${ids}]`);
      if (!PAGE) check(`${o.label}: ${spec} reaches the device`, new RegExp(`button ${id} pressed`).test(await events()));
    }
    if (!PAGE) {
      // glass: the pixel under the pointer, within 2 px, face-on and turned
      for (const rot of [null, [-0.1, 0.6, 0.05], [0.3, -0.7, -0.1]]) {
        await page.evaluate((r) => window.__dotbench3d.setViewDebug({ rotationZXY: r, elevationDeg: 8 }), rot);
        await sleep(400);
        let worst = 0;
        const bad = [];
        for (const [sx, sy] of [[100, 200], [330, 420], [1, 251], [408, 250], [205, 1], [204, 500], [40, 40]]) { // edges of the picture; its corners are rounded off
          const c = await at(`glass:${sx},${sy}`);
          await page.mouse.move(c.x, c.y);
          await page.mouse.down();
          await sleep(60);
          await page.mouse.up();
          const last = (await events()).split('\n').filter((l) => /^touch .* down$/.test(l)).pop() ?? '';
          const m = last.match(/touch (\d+),(\d+)/);
          const err = m ? Math.max(Math.abs(+m[1] - sx), Math.abs(+m[2] - sy)) : 999;
          worst = Math.max(worst, err);
          if (err > 2) bad.push(`(${sx},${sy}) -> ${last}`);
        }
        check(`${o.label}: glass clicks${rot ? ' (turned)' : ''} map to the pixel under the pointer within 2 px`, bad.length === 0, bad.length ? bad.join('; ') : `worst error ${worst} px over 7 points`);
      }
      // a drag that starts on the glass is a touch, not an orbit
      const p0 = await page.evaluate(() => window.__dotbench3d.pose());
      const g = await at('glass:205,251');
      await page.mouse.move(g.x, g.y);
      await page.mouse.down();
      await page.mouse.move(g.x + 80, g.y + 40, { steps: 5 });
      await page.mouse.up();
      const p1 = await page.evaluate(() => window.__dotbench3d.pose());
      check(`${o.label}: dragging on the glass does not orbit`, Math.abs(p1.roll - p0.roll) < 0.5 && Math.abs(p1.pitch - p0.pitch) < 0.5);
      // dragging the background orbits; all the way round is allowed (both sides and the back)
      await page.evaluate(() => window.__dotbench3d.setViewDebug({ rotationZXY: null }));
      await page.mouse.move(30, 450);
      await page.mouse.down();
      await page.mouse.move(700, 450, { steps: 20 });
      await page.mouse.up();
      await sleep(600);
      const p2 = await page.evaluate(() => window.__dotbench3d.pose());
      check(`${o.label}: dragging the background turns the model past the side, towards the back`, p2.roll - p1.roll > 150, `roll ${p1.roll.toFixed(0)} -> ${p2.roll.toFixed(0)}`);
    }
  }

  // ---- numbers
  await page.evaluate(() => window.__dotbench3d.setViewDebug({ rotationZXY: null, elevationDeg: 8, zoom: 1, offsetY: 0 }));
  await page.evaluate(() => window.__dotbench3d.setPoseDebug({ pitch: 0, roll: 17, heading: 0 }));
  await sleep(900);
  // render on demand: with a still picture and nothing held, no frame is drawn
  const f0 = await page.evaluate(() => window.__dotbench3d.rendered());
  await sleep(1500);
  const f1 = await page.evaluate(() => window.__dotbench3d.rendered());
  if (!PAGE && /still/.test(o.query ?? '')) check(`${o.label}: nothing is drawn while nothing changes (render on demand)`, f1 === f0, `${f1 - f0} frames in 1.5 s`);
  const info = await page.evaluate(() => window.__dotbench3d.info());
  // the machine is shared: the best of a few short runs is the least disturbed one
  let ms = Infinity;
  for (let i = 0; i < 5; i++) ms = Math.min(ms, await page.evaluate(() => window.__dotbench3d.bench(12)));
  const st = info.stats;
  console.log(`${o.label}: ${info.triangles} triangles${info.shellTriangles ? ` (${info.shellTriangles} of them the body shell)` : ''}, ${info.rendered} drawn in ${info.calls} draw calls${st ? `; file: ${st.sourceTriangles} triangles in ${st.sourceMeshes} meshes, ${st.sourceMaterials} materials, ${st.texturesResized} textures scaled down` : ''}; prepared in ${info.buildMs.toFixed(0)} ms`);
  console.log(`${o.label}: frame time ${ms.toFixed(1)} ms at ${W}x${H}, pixel ratio ${info.dpr}, on SwiftShader (software GL; a real GPU is far faster)`);
  if (info.warnings.length) console.log(`${o.label}: what was matched how:\n  - ${info.warnings.join('\n  - ')}`);
  const ignorable = (e) => PAGE && /model\.glb|404/.test(e); // a page without the bundled model asks for it once
  const real = errors.filter((e) => !ignorable(e));
  check(`${o.label}: no console errors`, real.length === 0, real.slice(0, 3).join(' | '));
  await page.close();
  return { info, ms };
}

if (!flags.has('--no-build')) await build();
// the bundled model for this run: the repository's (already in the build), or the file given with --kode
let placed = false;
if (kodeFile || flags.has('--glb')) {
  mkdirSync(dirname(distModel), { recursive: true });
  if (flags.has('--glb')) writeFileSync(distModel, syntheticGlb());
  else copyFileSync(kodeFile, distModel);
  placed = true;
} else if (kodeFile === '' && !existsSync(distModel)) {
  console.error(`--kode: there is no ${repoModel}; give the optimised file's path`);
  process.exit(2);
}
const stopServer = await serve();
let browser;
try {
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const b64 = (file) => readFileSync(file).toString('base64');
  if (customFile) {
    const raw = flags.has('--raw');
    const r = await session(browser, base, {
      label: raw ? 'custom (untouched)' : 'custom',
      prefix: raw ? 'model-custom-raw-' : 'model-custom-',
      query: 'still&model=simple',
      model: 'custom',
      dir: shotsArg ?? join(dirname(customFile), 'shots'),
      prepare: async (page) => {
        const state = await page.evaluate((data, name, raw) => (raw ? window.__stand.loadModelRaw(data, name) : window.__stand.loadModel(data, name)), b64(customFile), basename(customFile), raw);
        check(`custom: ${basename(customFile)} loads through the store`, state.status === 'ready', state.error ?? '');
        if (!raw) {
          // and it is kept in this browser only: a reload brings it back without the file
          await page.reload({ waitUntil: 'networkidle0' });
          await page.waitForFunction(() => window.__stand?.model.getState().status === 'ready', { timeout: 30000 }).catch(() => {});
          const again = await page.evaluate(() => window.__stand.model.getState());
          check('custom: the model comes back from the browser\'s own storage after a reload', again.status === 'ready' && again.name === basename(customFile), JSON.stringify({ status: again.status, name: again.name, error: again.error }));
        }
      },
    });
    if (r && !raw) {
      // refusals: readable, and the built-in model stays
      const page = await browser.newPage();
      await page.goto(`${base}/?debug&still&model=simple`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => !!window.__stand, { timeout: 20000 });
      const notGlb = await page.evaluate(() => window.__stand.loadModel(btoa('<!doctype html><html>not a model</html>'), 'page.glb'));
      check('custom: something that is not a GLB is refused with a readable message', notGlb.status === 'error' && /not a GLB/.test(notGlb.error ?? ''), notGlb.error);
      const shown = await page.evaluate(() => window.__dotbench3d.info().model);
      check('custom: after a refusal the built-in model is on show', shown === 'simple', shown);
      const tooBig = await page.evaluate(async () => {
        await window.__stand.model.load(new Blob([new Uint8Array(31 * 1024 * 1024)]), 'huge.glb');
        return window.__stand.model.getState();
      });
      check('custom: a file over 30 MB is refused', tooBig.status === 'error' && /limit is 30/.test(tooBig.error ?? ''), tooBig.error);
      await page.evaluate(() => window.__stand.model.remove());
      const gone = await page.evaluate(() => window.__stand.model.getState().status);
      check('custom: remove() goes back to the built-in model', gone === 'none', gone);
      await page.close();
    }
  } else if (kodeFile !== undefined || flags.has('--glb')) {
    const synthetic = flags.has('--glb');
    const own = !kodeFile && !synthetic;
    await session(browser, base, {
      label: synthetic ? 'documented node names (synthetic)' : 'kode',
      prefix: synthetic ? 'model-dropin-' : 'model-kode-',
      query: 'still&model=kode',
      model: 'kode',
      colours: !synthetic,
      dir: shotsArg ?? (synthetic ? join(OUT, 'shots') : own ? join(root, 'screenshots') : join(dirname(kodeFile), 'shots')),
    });
  } else {
    const r = await session(browser, base, { label: 'simple', prefix: 'model-', query: PAGE ? '' : 'still&model=simple', model: 'simple', dir: PAGE ? join(OUT, 'shots') : join(root, 'screenshots') });
    if (r) check('simple: the procedural model is in use', PAGE || r.info.model === 'simple');
  }
  const assets = join(OUT, 'assets');
  for (const f of readdirSync(assets)) if (/\.(js|wasm)$/.test(f)) console.log(`asset ${f}: ${(statSync(join(assets, f)).size / 1024).toFixed(0)} kB`);
} finally {
  await browser?.close();
  stopServer();
  if (placed) rmSync(distModel, { force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall model checks passed');
