// Headless Chrome verification of the built page. Usage: npm run build && node scripts/headless-check.mjs
// Starts `vite preview`, drives the page with puppeteer-core, writes screenshots to web/screenshots/.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { runLayoutAudit } from './layout-audit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'screenshots');
mkdirSync(shots, { recursive: true });
const PORT = 4173;
const BASE = `http://localhost:${PORT}/?debug`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// node runs vite directly (not through npx), so server.kill() really stops the preview and no orphan keeps the port
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('preview server did not start');
}

const consoleProblems = [];
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleProblems.push(`[${tag}] console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleProblems.push(`[${tag}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => consoleProblems.push(`[${tag}] requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) consoleProblems.push(`[${tag}] http ${r.status()}: ${r.url()}`);
  });
}

const logText = (page) => page.evaluate(() => window.__dotbench.device().log.get().map((l) => l.text).join('\n'));
const ledColor = (page) => page.$eval('[data-testid=led]', (e) => e.dataset.color);
const lastTouch = async (page) => {
  const t = await logText(page);
  const m = [...t.matchAll(/touch down at \((\d+), (\d+)\)/g)].pop();
  return m ? { x: +m[1], y: +m[2] } : null;
};
async function glassRect(page) {
  return page.$eval('[data-testid=glass]', (e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

// WCAG contrast of an element's text colour against its effective (first non-transparent) background.
const contrastOf = (page, sel) =>
  page.$eval(sel, (el) => {
    const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(el).color);
    let bg = [255, 255, 255];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c[3] ?? 1) > 0.5) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
async function checkTabContrast(page, label) {
  for (const id of ['left-tab-bench', 'left-tab-components']) {
    const sel = `[data-testid=${id}]`;
    const sel_ = await page.$eval(sel, (e) => e.getAttribute('aria-selected'));
    const r = await contrastOf(page, sel);
    check(`${label}: ${id} (${sel_ === 'true' ? 'active' : 'inactive'}) text contrast >= 4.5`, r >= 4.5, r.toFixed(2));
  }
}


// ---- menus: the mock toggle lives in the Device menu, the language in Settings
const fpsOf = (page) => page.$eval('[data-testid=status-fps]', (e) => Number(e.dataset.fps));
async function inMenu(page, menu, fn) {
  if (!(await page.$(`[data-testid=${menu === 'device-menu' ? 'device-popover' : 'settings-popover'}]`))) await page.click(`[data-testid=${menu}]`);
  await sleep(120);
  const r = await fn();
  await page.keyboard.press('Escape');
  await sleep(120);
  return r;
}
const toggleMock = (page) => inMenu(page, 'device-menu', () => page.click('[data-testid=mock-toggle]'));
const setLang = (page, lang) => inMenu(page, 'settings-menu', () => page.select('[data-testid=lang-select]', lang));
const clickIf = async (page, sel) => {
  const el = await page.$(sel);
  if (el) await el.evaluate((e) => e.click());
  return !!el;
};

// ---- real device helpers ---------------------------------------------------
const stateOf = (page) => page.$eval('[data-testid=status-state]', (e) => e.dataset.status);
async function until(fn, ms = 30000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await sleep(step);
  }
}
const waitStatus = (page, st, ms) => until(async () => (await stateOf(page)) === st, ms);
// distinct colours (sampled) and a content hash of the 2D screen canvas
const canvasStats = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid=screen-canvas]');
    if (!c) return { colours: 0, sig: 0 };
    const d = c.getContext('2d').getImageData(0, 0, 410, 502).data;
    const set = new Set();
    let sig = 7;
    for (let i = 0; i < d.length; i += 4 * 13) {
      set.add(d[i] | (d[i + 1] << 8) | (d[i + 2] << 16));
      sig = (sig * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    }
    return { colours: set.size, sig };
  });
const waitRealFrame = async (page, ms = 40000) => {
  const t = await until(async () => (await stateOf(page)) === 'running' && (await canvasStats(page)).colours > 5, ms);
  return t;
};
const rgbOf = (s) => (s.match(/\d+/g) || []).map(Number);
const ledGreen = (page) => until(async () => { const [r, g, b] = rgbOf(await ledColor(page)); return g >= 16 && r * 2 < g && b * 2 < g; }, 6000);
const ledRed = (page) => until(async () => { const [r, g, b] = rgbOf(await ledColor(page)); return r >= 16 && g * 2 < r && b * 2 < r; }, 6000);
const ledOf = (page) => page.evaluate(() => { const l = window.__dotbench.device().led.get(); return [l.r, l.g, l.b]; });
const phoneLedGreen = (page) => until(async () => { const [r, g, b] = await ledOf(page); return g >= 16 && r * 2 < g && b * 2 < g; }, 6000);
const phoneLedRed = (page) => until(async () => { const [r, g, b] = await ledOf(page); return r >= 16 && g * 2 < r && b * 2 < r; }, 6000);
async function glassPoint(page, sx, sy) {
  const r = await glassRect(page);
  return [r.left + ((sx + 0.5) / 410) * r.width, r.top + ((sy + 0.5) / 502) * r.height];
}
const logHas = (page, re) => page.$eval('[data-testid=console-log]', (e) => e.textContent).then((t) => re.test(t));
const sig = (page, clip) => page.screenshot({ clip, encoding: 'base64' });

// Find horizontal overflow offenders (elements whose content is wider than the box and not scrollable/ellipsized).
async function overflowOffenders(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw) out.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('[inert]') || el.closest('[aria-hidden=true]') || el.closest('.sr-only')) continue;
      if (el.closest('[data-testid=sheet]') && el.closest('[data-testid=sheet]').dataset.open === 'false') continue;
      const clipped = el.scrollWidth > el.clientWidth + 1 && !['auto', 'scroll'].includes(cs.overflowX) && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0 && !(el instanceof SVGElement) && cs.overflowX !== 'visible';
      const textSpill = cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.children.length === 0 && !(el instanceof SVGElement) && cs.display !== 'inline';
      if (clipped || textSpill) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? '[' + el.dataset.testid + ']' : ''} "${(el.textContent || '').trim().slice(0, 30)}" scroll ${el.scrollWidth} > client ${el.clientWidth}`);
    }
    return out;
  });
}

let browser;
try {
  await waitServer();
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });

  // ================= A. desktop 1440x900, light, 3D (default) =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'desktop');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dotbench.mock', 'true'); localStorage.getItem('dotbench.lang') ?? localStorage.setItem('dotbench.lang', '"en"'); });
    const resp = await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid=webgl-canvas]', { timeout: 15000 }).catch(() => {});
    await sleep(1500);

    const h = resp.headers();
    check('COOP header on served build', h['cross-origin-opener-policy'] === 'same-origin', h['cross-origin-opener-policy']);
    check('COEP header on served build', h['cross-origin-embedder-policy'] === 'require-corp', h['cross-origin-embedder-policy']);
    check('crossOriginIsolated is true', await page.evaluate(() => crossOriginIsolated === true));
    await page.click('[data-testid=status-details-toggle]');
    check('details read-out shows isolated=yes', (await page.$eval('[data-testid=status-isolated]', (e) => e.dataset.value)) === 'true');
    await page.keyboard.press('Escape');
    check('Escape closes the details popover and returns focus to its button', !(await page.$('[data-testid=status-details]')) && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'status-details-toggle');
    check('3D is the default view and a WebGL context exists', await page.evaluate(() => {
      const c = document.querySelector('[data-testid=webgl-canvas]');
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      return !!gl && !gl.isContextLost();
    }));

    // screen texture updates
    const v0 = await page.evaluate(() => window.__dotbench3d.textureVersion());
    const f0 = await page.evaluate(() => window.__dotbench3d.rendered());
    const g0 = await page.evaluate(() => window.__dotbench3d.project('glass:205,251'));
    const clip = { x: Math.max(0, g0.x - 120), y: Math.max(0, g0.y - 150), width: 240, height: 300 };
    const sA = await sig(page, clip);
    await sleep(900);
    const sB = await sig(page, clip);
    const v1 = await page.evaluate(() => window.__dotbench3d.textureVersion());
    const f1 = await page.evaluate(() => window.__dotbench3d.rendered());
    check('3D screen texture updates over time', v1 > v0 + 5, `texture.version ${v0} -> ${v1}`);
    check('3D scene re-renders as frames arrive', f1 > f0 + 5, `gl frames ${f0} -> ${f1}`);
    check('3D canvas pixels change over time', sA !== sB);
    const fps = await fpsOf(page);
    const fpsText = await page.$eval('[data-testid=status-fps]', (e) => e.textContent);
    check('status bar: redraw rate > 0, worded as a frame rate when it animates and as steady below 5 per second', fps > 0 && (/^\d+ fps$/.test(fpsText) || fpsText === 'steady'), `fps=${fps} text="${fpsText}"`);


    await checkTabContrast(page, 'light 1440');

    // click on the top button mesh -> LED
    const led0 = await ledColor(page);
    const top = await page.evaluate(() => window.__dotbench3d.project('top'));
    await page.mouse.click(top.x, top.y);
    await sleep(250);
    const led1 = await ledColor(page);
    check('3D: click on the top button mesh changes the LED', led1 !== led0, `${led0} -> ${led1}`);
    await page.mouse.click(top.x, top.y);
    await sleep(250);
    const led2 = await ledColor(page);
    check('3D: second click cycles the LED colour again', led2 !== led1, `${led1} -> ${led2}`);
    // keyboard T
    await page.keyboard.press('t');
    await sleep(250);
    const led3 = await ledColor(page);
    check('keyboard T changes the LED', led3 !== led2, `${led2} -> ${led3}`);
    // bottom mesh -> haptic
    const bot = await page.evaluate(() => window.__dotbench3d.project('bottom'));
    await page.mouse.click(bot.x, bot.y);
    check('3D: bottom button mesh press reaches the device', /button bottom pressed/.test(await logText(page)));

    // d-pad
    const dl = await page.evaluate(() => window.__dotbench3d.project('dpad:left'));
    await page.mouse.click(dl.x, dl.y);
    check('3D: d-pad left mesh press reaches the device', /button left pressed/.test(await logText(page)));

    // glass clicks: touch coordinates within 2px
    for (const [sx, sy] of [[100, 200], [330, 420], [60, 60]]) {
      const p = await page.evaluate(([x, y]) => window.__dotbench3d.project(`glass:${x},${y}`), [sx, sy]);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await sleep(220);
      const t = await lastTouch(page);
      await page.mouse.up();
      check(`3D: glass click at screen (${sx},${sy}) maps within 2px`, t && Math.abs(t.x - sx) <= 2 && Math.abs(t.y - sy) <= 2, JSON.stringify(t));
    }
    // glass drag does not orbit
    const poseBefore = await page.evaluate(() => window.__dotbench3d.pose());
    const gp = await page.evaluate(() => window.__dotbench3d.project('glass:205,251'));
    await page.mouse.move(gp.x, gp.y);
    await page.mouse.down();
    await page.mouse.move(gp.x + 80, gp.y + 40, { steps: 6 });
    await page.mouse.up();
    const poseAfter = await page.evaluate(() => window.__dotbench3d.pose());
    check('3D: dragging on the glass does not orbit', Math.abs(poseAfter.roll - poseBefore.roll) < 0.5 && Math.abs(poseAfter.pitch - poseBefore.pitch) < 0.5);

    // Movimento object: add, shake
    await page.click('[data-testid="add-motion.pose"]');
    await sleep(200);
    await page.click('[data-testid=action-shake]');
    await sleep(200);
    check('Movimento: shake button reaches the device', /motion: shake/.test(await logText(page)));
    await page.$eval('[data-testid=field-roll]', (el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '40');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    const mockPose = await page.evaluate(() => 1);
    void mockPose;
    // orbit with background drag (tilt link off => local only)
    await page.mouse.move(420, 450);
    await page.mouse.down();
    await page.mouse.move(420 + 220, 450, { steps: 12 });
    await page.mouse.up();
    await sleep(700);
    const orb = await page.evaluate(() => window.__dotbench3d.pose());
    check('3D: dragging the background rotates the model', Math.abs(orb.roll) > 40, `roll=${orb.roll.toFixed(1)}`);
    await page.screenshot({ path: join(shots, '3d-orbited-side.png') });

    // tilt link: orbit drives the sliders
    await page.click('[data-testid=recenter]');
    await sleep(600);
    await page.click('[data-testid=tilt-link]');
    await sleep(200);
    await page.mouse.move(420, 450);
    await page.mouse.down();
    await page.mouse.move(420 + 100, 450 - 60, { steps: 10 });
    await page.mouse.up();
    await sleep(500);
    const rollField = Number(await page.$eval('[data-testid=field-roll]', (e) => e.value));
    const pitchField = Number(await page.$eval('[data-testid=field-pitch]', (e) => e.value));
    check('tilt link: orbit drag moves the Movimento sliders', Math.abs(rollField) > 20 && Math.abs(pitchField) > 10, `roll=${rollField} pitch=${pitchField}`);
    await page.$eval('[data-testid=field-heading]', (el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '90');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(700);
    const hp = await page.evaluate(() => window.__dotbench3d.pose());
    check('tilt link: sliders move the model', Math.abs(hp.heading - 90) < 2, `heading=${hp.heading.toFixed(1)}`);
    await page.click('[data-testid=tilt-link]');

    // bundles: upload, notices, wasm placeholder
    writeFileSync('/tmp/demo.dotbench', Buffer.from('not a real bundle'));
    await page.click('[data-testid=apps-menu]');
    const input = await page.$('[data-testid=file-input]');
    await input.uploadFile('/tmp/demo.dotbench');
    await sleep(600);
    check('the picker closes once a file was chosen', !(await page.$('[data-testid=apps-popover]')));
    await page.click('[data-testid=apps-menu]');
    await sleep(150);
    const listed = await page.$$eval('[data-testid=bundle-list] li', (l) => l.map((x) => x.textContent));
    check('bundle is stored in IndexedDB and listed with size/date', listed.length === 1 && /demo/.test(listed[0]) && /B/.test(listed[0]), JSON.stringify(listed));
    await page.keyboard.press('Escape');
    check('Escape closes the picker and returns focus to its button', !(await page.$('[data-testid=apps-popover]')) && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'apps-menu');
    const n1 = await page.$eval('[data-testid=notice]', (e) => e.textContent).catch(() => '');
    check('mock + real bundle shows a clear notice', /does not run \.dotbench/.test(n1), n1);
    await toggleMock(page);
    await sleep(300);
    await page.click('[data-testid=apps-menu]').catch(() => {});
    await sleep(150);
    await page.evaluate(() => document.querySelector('[data-testid=bundle-list] li button')?.click());
    await sleep(400);
    const n2 = await page.$eval('[data-testid=notice]', (e) => e.textContent).catch(() => '');
    check('real device + a broken bundle shows a clear error notice, no crash', /Could not load "demo"/.test(n2), n2);
    await page.click('[data-testid=restart]');
    await sleep(300);
    check('Restart with nothing loaded is handled', /Could not load/.test(await page.$eval('[data-testid=notice]', (e) => e.textContent)));
    await toggleMock(page);
    await sleep(1200);
    check('mock back on: device runs again', (await page.$eval('[data-testid=status-state]', (e) => e.dataset.status)) === 'running');

    // language switch
    const navBefore = await page.$eval('[data-testid=left-tab-bench]', (e) => e.textContent);
    await setLang(page, 'pt-BR');
    await sleep(200);
    const navPt = await page.$eval('[data-testid=left-tab-bench]', (e) => e.textContent);
    check('language switch to pt-BR changes visible text and <html lang>', navBefore === 'Bench' && navPt === 'Bancada' && (await page.evaluate(() => document.documentElement.lang)) === 'pt-BR', `${navBefore} -> ${navPt}`);
    await setLang(page, 'es');
    await sleep(200);
    check('language switch to es', (await page.$eval('[data-testid=left-tab-components]', (e) => e.textContent)) === 'Componentes' && (await page.$eval('[data-testid=restart]', (e) => e.textContent)) === 'Reiniciar');
    check('Components section has two honest placeholders', await (async () => {
      await page.click('[data-testid=left-tab-components]');
      return (await page.$$('[data-testid=components-panel] li')).length === 2;
    })());
    check('document title names the product and its descriptor in the page language', (await page.title()) === 'KodeDot Sim · Simulador de apps para Kode Dot', await page.title());
    await setLang(page, 'en');
    check('wordmark and title say KodeDot Sim', (await page.title()) === 'KodeDot Sim · A simulator for Kode Dot apps' && (await page.$eval('[data-testid=brand]', (e) => e.textContent.trim())) === 'KodeDot Sim');
    check('settings name the product with its descriptor and carry no notices', await inMenu(page, 'settings-menu', () => page.$eval('[data-testid=about]', (e) => e.textContent.trim() === 'KodeDot Sim · A simulator for Kode Dot apps')));
    await page.click('[data-testid=left-tab-bench]');

    // tabs follow the ARIA pattern: arrows move and select, and do not reach the D-pad
    await page.focus('[data-testid=left-tab-bench]');
    const logBeforeArrows = await logText(page);
    await page.keyboard.press('ArrowRight');
    await sleep(150);
    check('tabs: ArrowRight selects the next tab and keeps focus on it', (await page.$eval('[data-testid=left-tab-components]', (e) => e.getAttribute('aria-selected') === 'true' && document.activeElement === e)));
    check('tabs: arrow keys on a tab do not press the D-pad', (await logText(page)) === logBeforeArrows);
    await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => document.activeElement.blur());

    // 2D mode: Fit is the default; 3D can be entered again afterwards
    await page.click('[data-testid=view-2d]');
    await sleep(700);
    check('2D opens in Fit: the whole device is inside the stage', await page.evaluate(() => {
      const b = document.querySelector('[data-testid=device-2d-body]').getBoundingClientRect();
      const st = document.querySelector('[data-testid=stage]').getBoundingClientRect();
      return document.querySelector('[data-testid=zoom-fit]').getAttribute('aria-pressed') === 'true' && b.top >= st.top - 0.5 && b.bottom <= st.bottom + 0.5 && b.left >= st.left - 0.5 && b.right <= st.right + 0.5;
    }));
    await sleep(900); // the 3D canvas releases its context a moment after unmounting
    check('leaving 3D is not reported as a lost context: no notice, 3D stays available', !(await page.$('[data-testid=notice][data-kind=info]')) && !(await page.$eval('[data-testid=view-3d]', (e) => e.disabled)));
    await page.click('[data-testid=view-3d]');
    await page.waitForSelector('[data-testid=webgl-canvas]', { timeout: 15000 }).catch(() => {});
    await sleep(600);
    check('3D -> 2D -> 3D: the 3D view comes back', await page.evaluate(() => {
      const c = document.querySelector('[data-testid=webgl-canvas]');
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      return !!gl && !gl.isContextLost();
    }));
    await page.click('[data-testid=view-2d]');
    await sleep(500);
    await page.click('[data-testid=zoom-1]');
    await sleep(400);
    check('2D at 1x pans and opens centred on the screen', await page.evaluate(() => {
      const pan = document.querySelector('[data-testid=device-2d]');
      const g = document.querySelector('[data-testid=glass]').getBoundingClientRect();
      const p = pan.getBoundingClientRect();
      return pan.dataset.pans === 'true' && pan.tabIndex === 0 && Math.abs((g.left + g.right) / 2 - (p.left + p.right) / 2) < 12 && g.top >= p.top - 1;
    }));
    const c0 = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=screen-canvas]');
      return c.getContext('2d').getImageData(0, 0, 410, 502).data.reduce((a, v, i) => (i % 97 === 0 ? (a * 31 + v) >>> 0 : a), 7);
    });
    await sleep(700);
    const c1 = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=screen-canvas]');
      return c.getContext('2d').getImageData(0, 0, 410, 502).data.reduce((a, v, i) => (i % 97 === 0 ? (a * 31 + v) >>> 0 : a), 7);
    });
    check('2D: screen canvas is painting (pixels change over time)', c0 !== c1);
    const dims = await page.$eval('[data-testid=screen-canvas]', (c) => [c.width, c.height]);
    check('2D: canvas is exactly 410x502 logical px', dims[0] === 410 && dims[1] === 502, dims.join('x'));
    const r = await glassRect(page);
    check('2D at 1x: glass is 410x502 CSS px (pixel-exact)', Math.abs(r.width - 410) < 0.5 && Math.abs(r.height - 502) < 0.5, `${r.width}x${r.height}`);
    for (const [sx, sy] of [[60, 60], [200, 250], [350, 440]]) {
      const rr = await glassRect(page);
      await page.mouse.move(rr.left + ((sx + 0.5) / 410) * rr.width, rr.top + ((sy + 0.5) / 502) * rr.height);
      await page.mouse.down();
      await sleep(60);
      const t = await lastTouch(page);
      await page.mouse.up();
      check(`2D: glass click at (${sx},${sy}) maps within 2px`, t && Math.abs(t.x - sx) <= 2 && Math.abs(t.y - sy) <= 2, JSON.stringify(t));
    }
    const l2a = await ledColor(page);
    await page.$eval('[data-button=top]', (e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
    await sleep(100);
    const tb = await page.$eval('[data-button=top]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(tb.x, tb.y);
    await sleep(200);
    check('2D: clicking the top button changes the LED', (await ledColor(page)) !== l2a);
    await page.mouse.move(tb.x, tb.y);
    await page.mouse.down();
    check('2D: held button shows pressed state', (await page.$eval('[data-button=top]', (e) => e.dataset.pressed)) === 'true');
    await page.mouse.up();
    await ctx.close();
  }

  // ================= B. desktop 1280x720 light, 2D screenshot =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'laptop');
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('dotbench.theme', '"light"');
      localStorage.setItem('dotbench.view', '"2d"');
      localStorage.setItem('dotbench.zoom2d', '"fit"');
      localStorage.setItem('dotbench.lang', '"en"');
    });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await waitRealFrame(page);
    await page.click('[data-testid="add-motion.pose"]');
    await page.click('[data-testid=action-shake]');
    await page.keyboard.press('t');
    await sleep(600);
    check('laptop 1280x720: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(shots, '2d-light-1280x720.png') });
    await page.click('[data-testid=left-tab-components]');
    await sleep(300); // colours cross-fade in 150 ms
    await checkTabContrast(page, 'light 1280 (components active)');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(350);
    await checkTabContrast(page, 'dark 1280');
    await page.screenshot({ path: join(shots, '2d-dark-1280x720.png') });
    await ctx.close();
  }

  // ================= C. phone portrait 390x844 @3x touch =================
  for (const lang of ['en', 'es', 'pt-BR']) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, `phone-${lang}`);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument((l) => { localStorage.setItem('dotbench.mock', 'true'); localStorage.setItem('dotbench.lang', JSON.stringify(l)); }, lang);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await sleep(800);
    if (lang === 'en') {
      check('phone portrait: layout detected, 2D render path by default', (await page.$eval('[data-testid=phone-root]', (e) => e.dataset.layout)) === 'phone-portrait' && !!(await page.$('[data-testid=device-2d]')));
      check('phone portrait: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
      const body = await page.$eval('[data-testid=device-2d-body]', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, t: r.top, h: r.height }; });
      check('phone portrait: device front fills the width edge to edge', body.w >= 388 && body.l >= -0.5, JSON.stringify(body));
      check('phone portrait: device is inside the viewport vertically', body.t >= 0 && body.t + body.h <= 844 - 40, JSON.stringify(body));
      const btns = await page.$$eval('[data-button]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.button, w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
      check('phone portrait: six buttons present', btns.length === 6, btns.map((b) => b.id).join(','));
      check('phone portrait: every button hit box >= 44 CSS px', btns.every((b) => b.w >= 43.9 && b.h >= 43.9), btns.map((b) => `${b.id}:${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(' '));
      check('phone portrait: every button inside the viewport (safe area)', btns.every((b) => b.l >= 0 && b.t >= 0 && b.r <= 390 && b.b <= 844));
      const ta = await page.$eval('[data-testid=glass]', (e) => getComputedStyle(e).touchAction);
      check('glass has touch-action: none', ta === 'none', ta);
      check('body has overscroll-behavior: none', (await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY)) === 'none');
      check('viewport meta has viewport-fit=cover and no user zoom', await page.evaluate(() => { const c = document.querySelector('meta[name=viewport]').content; return /viewport-fit=cover/.test(c) && /user-scalable=no/.test(c); }));

      // touch on the glass
      const gr = await glassRect(page);
      const at = (sx, sy) => [gr.left + ((sx + 0.5) / 410) * gr.width, gr.top + ((sy + 0.5) / 502) * gr.height];
      const [tx, ty] = at(120, 300);
      const th = await page.touchscreen.touchStart(tx, ty);
      await sleep(80);
      const t = await lastTouch(page);
      check('phone: synthetic touch on the glass maps within 2px', t && Math.abs(t.x - 120) <= 2 && Math.abs(t.y - 300) <= 2, JSON.stringify(t));
      // drag across the device: no scroll or zoom
      const s0 = await page.evaluate(() => ({ y: scrollY, x: scrollX, z: visualViewport.scale, st: document.scrollingElement.scrollTop }));
      for (let i = 1; i <= 8; i++) await th.move(tx, ty + i * 25), await sleep(16);
      await th.end();
      const s1 = await page.evaluate(() => ({ y: scrollY, x: scrollX, z: visualViewport.scale, st: document.scrollingElement.scrollTop }));
      check('phone: touch-drag over the device does not scroll or zoom the page', JSON.stringify(s0) === JSON.stringify(s1), `${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`);
      const [ux, uy] = at(120, 460);
      void ux; void uy;
      const lastLine = (await logText(page)).split('\n').filter((x) => /touch up/.test(x)).pop();
      check('phone: touch release reaches the device', !!lastLine, lastLine);

      // second finger is ignored
      const a = await page.touchscreen.touchStart(...at(50, 50));
      const b2 = await page.touchscreen.touchStart(...at(300, 400));
      await sleep(80);
      const downs = (await logText(page)).match(/touch down/g)?.length ?? 0;
      await a.end();
      await b2.end();
      check('phone: only the first pointer drives touch', downs === 2, `touch-down lines total=${downs} (1 earlier + 1 now)`);

      // button touch and hold
      const bt = await page.$eval('[data-button=top]', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
      const l0 = await page.evaluate(() => window.__dotbench.device().led.get());
      const bh = await page.touchscreen.touchStart(...bt);
      await sleep(100);
      const pressed = await page.$eval('[data-button=top]', (e) => e.dataset.pressed);
      await bh.end();
      const l1 = await page.evaluate(() => window.__dotbench.device().led.get());
      check('phone: touching a button presses it (feedback + device)', pressed === 'true' && JSON.stringify(l0) !== JSON.stringify(l1));
      // hidden page releases buttons
      const bh2 = await page.touchscreen.touchStart(...bt);
      await sleep(60);
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await sleep(60);
      check('phone: page hidden releases held buttons', (await page.evaluate(() => window.__dotbench.input.pressed.get().size)) === 0);
      await bh2.end().catch(() => {});
      await page.evaluate(() => delete document.visibilityState);

      await page.screenshot({ path: join(shots, 'phone-portrait.png') });
    }

    // bottom sheet
    const handle = await page.$('[data-testid=sheet-handle]');
    const hb = await handle.boundingBox();
    if (lang === 'en') check('phone: sheet handle is a >= 44px target outside the device art', hb.height >= 44 && hb.width >= 44, `${hb.width}x${hb.height}`);
    if (lang === 'en') {
      const bar = await page.$$eval('[data-testid=sheet] [data-testid^=tab-]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), h: Math.round(r.height) }; }));
      check('phone: the closed sheet shows its four tabs as a bar, all inside the viewport', bar.length === 4 && bar.every((r) => r.l >= 0 && r.r <= 390 && r.b <= 844 && r.h >= 44), JSON.stringify(bar));
      check('phone: the content of the closed sheet is inert', await page.evaluate(() => !!document.querySelector('[data-testid=bench-panel]')?.closest('[inert]')));
    }
    await handle.tap();
    await sleep(400);
    const open1 = await page.$eval('[data-testid=sheet]', (e) => e.dataset.open);
    if (lang === 'en') {
      check('phone: bottom sheet opens', open1 === 'true');
      check('phone: half-open sheet leaves the whole device visible above it', await page.evaluate(() => {
        const b = document.querySelector('[data-testid=device-2d-body]').getBoundingClientRect();
        const s = document.querySelector('[data-testid=sheet]').getBoundingClientRect();
        return b.bottom <= s.top + 1 && b.top >= 0 && b.height > 200;
      }));
    }
    for (const tab of ['bench', 'components', 'console', 'apps', 'settings']) {
      if (tab === 'components') {
        await page.tap('[data-testid=tab-bench]');
        await page.tap('[data-testid=left-tab-components]');
      } else await page.tap(`[data-testid=tab-${tab}]`);
      await sleep(250);
      const off = await overflowOffenders(page);
      check(`phone 390px [${lang}] tab ${tab}: nothing overflows`, off.length === 0, off.slice(0, 4).join(' | '));
    }
    if (lang === 'en') {
      await page.tap('[data-testid=sheet-handle]');
      await sleep(400);
      check('phone: a second tap on the handle opens the sheet fully', (await page.$eval('[data-testid=sheet]', (e) => e.dataset.detent)) === 'full');
      await page.keyboard.press('Escape');
      await sleep(400);
      check('phone: Escape closes the sheet', (await page.$eval('[data-testid=sheet]', (e) => e.dataset.open)) === 'false');
      await page.tap('[data-testid=tab-bench]');
      await sleep(400);
    }
    await page.tap('[data-testid=tab-bench]');
    await page.tap('[data-testid=left-tab-bench]');
    if (lang === 'en') await page.screenshot({ path: join(shots, 'phone-sheet-open.png') });
    await page.tap('[data-testid=sheet-close]');
    await sleep(400);
    if (lang === 'en') check('phone: bottom sheet closes', (await page.$eval('[data-testid=sheet]', (e) => e.dataset.open)) === 'false');
    await ctx.close();
  }

  // ================= D. phone landscape 844x390 =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'phone-landscape');
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dotbench.mock', 'true'); localStorage.setItem('dotbench.lang', '"en"'); });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await sleep(800);
    check('landscape: layout detected', (await page.$eval('[data-testid=phone-root]', (e) => e.dataset.layout)) === 'phone-landscape');
    check('landscape: no scroll in either direction', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
    // landscape has room for both: the panel is docked beside the device and open from the start
    const side = await page.$eval('[data-testid=sheet]', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, open: e.dataset.open }; });
    const body0 = await page.$eval('[data-testid=device-2d-body]', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; });
    check('landscape: panel docked beside the device, device at full height and not covered', side.open === 'true' && body0.h >= 385 && body0.l >= 0 && body0.r <= side.l + 1, JSON.stringify({ side, body0 }));
    await page.tap('[data-testid=sheet-close]');
    await sleep(450);
    const body = await page.$eval('[data-testid=device-2d-body]', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, t: r.top, h: r.height }; });
    check('landscape: with the panel closed the device is centred at full height', body.h >= 385 && Math.abs(body.l + body.w / 2 - 422) < 2, JSON.stringify(body));
    const btns = await page.$$eval('[data-button]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.button, w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
    check('landscape: every button hit box >= 44 CSS px and inside the viewport', btns.length === 6 && btns.every((b) => b.w >= 43.9 && b.h >= 43.9 && b.l >= 0 && b.t >= 0 && b.r <= 844 && b.b <= 390), btns.map((b) => `${b.id}:${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(' '));
    const gr = await glassRect(page);
    await page.touchscreen.touchStart(gr.left + (101 / 410) * gr.width, gr.top + (201 / 502) * gr.height).then((h) => h.end());
    const t = await lastTouch(page);
    check('landscape: touch on the glass maps within 2px', t && Math.abs(t.x - 100) <= 2 && Math.abs(t.y - 200) <= 2, JSON.stringify(t));
    await page.screenshot({ path: join(shots, 'phone-landscape.png') });
    await page.tap('[data-testid=sheet-handle]');
    await sleep(400);
    const sb = await page.$eval('[data-testid=sheet]', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height, open: e.dataset.open }; });
    check('landscape: sheet opens as a side panel', sb.open === 'true' && sb.h >= 388 && sb.l > 300, JSON.stringify(sb));
    await page.screenshot({ path: join(shots, 'phone-landscape-sheet.png') });
    await page.tap('[data-testid=sheet-close]');
    await sleep(400);
    check('landscape: sheet closes', (await page.$eval('[data-testid=sheet]', (e) => e.dataset.open)) === 'false');
    await ctx.close();
  }

  // ================= E. tablet drawers =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'tablet');
    await page.setViewport({ width: 820, height: 1180 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dotbench.mock', 'true'); localStorage.setItem('dotbench.lang', '"en"'); localStorage.setItem('dotbench.view', '"2d"'); });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await sleep(400);
    await page.click('[data-testid=drawer-bench]');
    await page.click('[data-testid=drawer-console]');
    await sleep(200);
    const drawerOpen = (which) => page.$eval(`[data-testid=drawer-${which}-panel]`, (e) => e.dataset.open === 'true' && getComputedStyle(e).visibility === 'visible');
    check('tablet: one drawer at a time, the console replaces the bench', (await drawerOpen('console')) && !(await drawerOpen('bench')));
    check('tablet: the console drawer shows its log at a usable height', (await page.$eval('[data-testid=console-log]', (e) => e.getBoundingClientRect().height)) > 300);
    await sleep(300);
    await page.screenshot({ path: join(shots, 'tablet-drawer-console.png') });
    await page.keyboard.press('Escape');
    await sleep(300);
    check('tablet: Escape closes the drawer and returns focus to its toggle', !(await drawerOpen('console')) && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'drawer-console');
    await page.click('[data-testid=drawer-bench]');
    await sleep(400);
    check('tablet: the bench drawer opens', await drawerOpen('bench'));
    await page.screenshot({ path: join(shots, 'tablet-drawers.png') });
    await ctx.close();
  }


  // ================= F. REAL device, desktop 1440x900, 2D (independent of the 3D model) =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'real-desktop');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dotbench.view', '"2d"'); localStorage.setItem('dotbench.zoom2d', '"fit"'); localStorage.setItem('dotbench.lang', '"en"'); });
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=status-state]');
    const ttff = await waitRealFrame(page);
    const ttffTotal = Date.now() - t0;
    check('real: first visit starts the display_lvgl demo by itself and shows a real frame', ttff >= 0, `time to first real frame ${ttffTotal} ms from navigation`);
    console.log(`METRIC time-to-first-frame (navigation to non-uniform LVGL frame): ${ttffTotal} ms`);
    check('real: status bar names the app "Display"', (await page.$eval('[data-testid=status-app]', (e) => e.textContent)) === 'Display');
    check('real: mock toggle is off by default and labelled as a test device', await inMenu(page, 'device-menu', async () => (await page.$eval('[data-testid=mock-toggle]', (e) => e.checked)) === false && /Test device/.test(await page.$eval('label:has([data-testid=mock-toggle])', (e) => e.textContent))));
    check('real: an idle app reads as a steady screen, not as a low frame rate', /steady/.test(await page.$eval('[data-testid=status-fps]', (e) => e.textContent)) && !/FPS/.test(await page.$eval('[data-testid=status-bar]', (e) => e.textContent)), await page.$eval('[data-testid=status-fps]', (e) => `${e.textContent} (${e.dataset.fps}/s)`));
    check('real: console lines are clean: one time column, no firmware prefix, no ISO stamp', await page.$eval('[data-testid=console-log]', (e) => !/!I |\d{4}-\d\d-\d\dT/.test(e.textContent) && e.querySelectorAll('time').length > 3));
    check('real: the first-visit hint is shown and leaves for good', (await page.$('[data-testid=welcome]')) !== null && (await page.click('[data-testid=welcome-dismiss]').then(() => sleep(100)).then(() => page.$('[data-testid=welcome]'))) === null);
    check('real: boot log line reaches the console panel', await logHas(page, /display_lvgl|app_main/));
    check('real: no boot overlay or crash card once running', !(await page.$('[data-testid=device-booting]')) && !(await page.$('[data-testid=device-crash]')));
    const st0 = await canvasStats(page);
    check('real: screen is a non-uniform real frame', st0.colours > 5, `${st0.colours} sampled colours`);

    // touch changes the picture
    const [gx, gy] = await glassPoint(page, 205, 251);
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await sleep(500);
    const st1 = await canvasStats(page);
    let fpsMax = 0;
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(gx + (i % 2 ? 30 : -30), gy + i * 4);
      await sleep(120);
      fpsMax = Math.max(fpsMax, await fpsOf(page));
    }
    await page.mouse.up();
    check('real: touching the glass changes the picture', st1.sig !== st0.sig);
    console.log(`METRIC fps while dragging a finger over the LVGL screen (status bar, frames that changed per second): ${fpsMax}`);
    check('real: status bar fps is a real number', fpsMax > 0, `max ${fpsMax}`);
    await page.click('[data-testid=status-details-toggle]');
    const workers = Number(await page.$eval('[data-testid=status-workers]', (e) => e.textContent));
    const mem = await page.$eval('[data-testid=status-memory]', (e) => e.textContent);
    check('real: details pill shows worker count and wasm memory', workers > 0 && /MB/.test(mem), `${workers} workers, ${mem}`);
    await page.keyboard.press('Escape');
    console.log(`METRIC adapter diagnostics: ${workers} workers, ${mem}`);

    // switch to buttons_led from the picker
    await page.click('[data-testid=apps-menu]');
    check('real: picker lists the built-in apps', (await page.$$('[data-testid=builtin-list] li')).length >= 2);
    await page.click('[data-testid=builtin-buttons_led]');
    await page.keyboard.press('Escape');
    const tLed = await ledGreen(page);
    check('real: buttons_led boots and its LED indicator turns green', tLed >= 0, `${tLed} ms`);
    check('real: buttons_led boot line appears in the console panel', await logHas(page, /buttons_led/));
    await page.$eval('[data-button=top]', (e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
    await sleep(150);
    const tb = await page.$eval('[data-button=top]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(tb.x, tb.y); await page.mouse.down(); await sleep(200); await page.mouse.up(); await sleep(500);
    check('real: clicking the top button turns the LED red', (await ledRed(page)) >= 0, await ledColor(page));
    await page.mouse.move(tb.x, tb.y); await page.mouse.down(); await sleep(200); await page.mouse.up(); await sleep(500);
    check('real: a second click turns the LED green again', (await ledGreen(page)) >= 0, await ledColor(page));
    await page.keyboard.down('t'); await sleep(200); await page.keyboard.up('t'); await sleep(300);
    check('real: the keyboard shortcut for the top button also toggles the LED', (await ledRed(page)) >= 0, await ledColor(page));

    // back to display_lvgl, restart, stop
    await page.click('[data-testid=apps-menu]');
    await page.click('[data-testid=builtin-display_lvgl]');
    await page.keyboard.press('Escape');
    check('real: switching back to display_lvgl shows a real frame', (await waitRealFrame(page)) >= 0);
    await page.click('[data-testid=restart]');
    const sawBoot = await until(async () => (await stateOf(page)) === 'booting', 3000, 10);
    check('real: Restart goes through booting', sawBoot >= 0 || (await stateOf(page)) === 'running');
    check('real: after Restart the app runs and draws again', (await waitRealFrame(page)) >= 0);
    await page.click('[data-testid=stop]');
    check('real: Stop returns to idle and says so over the device, with a Start action', (await waitStatus(page, 'idle', 5000)) >= 0 && !!(await page.$('[data-testid=device-idle]')) && !!(await page.$('[data-testid=idle-start]')));
    check('real: the idle card is fully inside the stage', await page.evaluate(() => {
      const c = document.querySelector('[data-testid=device-idle] > div').getBoundingClientRect();
      const st = document.querySelector('[data-testid=stage]').getBoundingClientRect();
      return c.top >= st.top && c.bottom <= st.bottom && c.left >= st.left && c.right <= st.right;
    }));
    await page.click('[data-testid=idle-start]');
    check('real: Restart after Stop runs again', (await waitRealFrame(page)) >= 0);

    // device menu: export, import
    await page.click('[data-testid=device-menu]');
    check('real: device menu offers Export and Import', !!(await page.$('[data-testid=device-export]')) && !!(await page.$('[data-testid=device-import]')));
    await page.click('[data-testid=device-export]');
    await sleep(500);
    check('real: Export device reports success', /Device exported/.test(await page.$eval('[data-testid=notice]', (e) => e.textContent).catch(() => '')));
    check('real: no horizontal scroll at 1440x900', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ctx.close();
  }

  // ================= G. REAL device, desktop 1440x900, 3D light: screenshot =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'real-3d');
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('dotbench.lang', '"en"'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=webgl-canvas]', { timeout: 30000 }).catch(() => {});
    check('real 3D: the app runs behind the 3D view', (await waitStatus(page, 'running', 40000)) >= 0);
    await sleep(2500);
    await checkTabContrast(page, 'light 1440');
    await page.screenshot({ path: join(shots, '3d-light-1440x900.png') });
    await ctx.close();
  }

  // ================= H. REAL device, phone portrait =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'real-phone');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => localStorage.setItem('dotbench.lang', '"en"'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=glass]', { timeout: 30000 });
    // phone has no status bar: wait on the debug hook
    const ready = await until(async () => (await page.evaluate(() => window.__dotbench?.device().status.get())) === 'running' && (await canvasStats(page)).colours > 5, 40000);
    check('real phone: display_lvgl starts by itself and draws a real frame', ready >= 0);
    await sleep(400);
    await page.screenshot({ path: join(shots, 'phone-portrait.png') });
    const p0 = await canvasStats(page);
    const [tx, ty] = await glassPoint(page, 205, 251);
    await page.touchscreen.touchStart(tx, ty);
    await sleep(600);
    const p1 = await canvasStats(page);
    await page.touchscreen.touchEnd();
    check('real phone: a touch on the glass changes the picture', p1.sig !== p0.sig);
    await page.click('[data-testid=sheet-handle]');
    await sleep(500);
    await page.screenshot({ path: join(shots, 'phone-sheet-open.png') });
    await page.click('[data-testid=tab-apps]');
    check('real phone: sheet lists the built-in apps', (await page.$$('[data-testid=builtin-list] li')).length >= 2);
    await page.click('[data-testid=builtin-buttons_led]');
    check('real phone: buttons_led LED turns green', (await phoneLedGreen(page)) >= 0);
    await sleep(400);
    check('real phone: choosing an app folds the sheet back to its bar', (await page.$eval('[data-testid=sheet]', (e) => e.dataset.open)) === 'false');
    await clickIf(page, '[data-testid=sheet-close]');
    await sleep(400);
    const b = await page.$eval('[data-button=top]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.touchStart(b.x, b.y); await sleep(200); await page.touchscreen.touchEnd(); await sleep(600);
    check('real phone: tapping the top button turns the LED red', (await phoneLedRed(page)) >= 0, JSON.stringify(await ledOf(page)));
    await page.touchscreen.touchStart(b.x, b.y); await sleep(200); await page.touchscreen.touchEnd(); await sleep(600);
    check('real phone: a second tap turns it green again', (await phoneLedGreen(page)) >= 0, JSON.stringify(await ledOf(page)));
    check('real phone: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ctx.close();
  }

  // ================= I. browser that cannot run apps (not cross-origin isolated), phone =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'unsupported-phone');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => localStorage.setItem('dotbench.lang', '"en"'));
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.isNavigationRequest() && req.resourceType() === 'document') {
        const r = await fetch(req.url());
        const headers = Object.fromEntries([...r.headers].filter(([k]) => !/^cross-origin-(opener|embedder)-policy$/i.test(k)));
        req.respond({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
      } else req.continue();
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=device-unsupported]', { timeout: 20000 }).catch(() => {});
    const txt = await page.$eval('[data-testid=device-unsupported]', (e) => e.textContent).catch(() => '');
    check('unsupported browser (phone): a friendly card names the cause', /cannot run apps/.test(txt) && /cross-origin isolated/.test(txt), txt.slice(0, 120));
    check('unsupported browser (phone): nothing crashed, no overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(shots, 'phone-unsupported.png') });
    await ctx.close();
  }

  // ================= K. "3D model" entry and dropped files (stand-in model store; the real one belongs to the 3D code) =================
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    watch(page, 'model');
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('dotbench.mock', 'true'); localStorage.setItem('dotbench.lang', '"en"'); localStorage.setItem('dotbench.view', '"2d"'); localStorage.setItem('dotbench.welcomed', 'true'); });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!window.__dotbench);
    const drop = (name) => page.evaluate(async (n) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(2048)], n));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      await new Promise((r) => setTimeout(r, 120)); // the overlay appears while the file hovers
      const shown = document.querySelector('[data-testid=drop-overlay]')?.textContent ?? '';
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return shown;
    }, name);
    const noticeText = () => page.$eval('[data-testid=notice]', (e) => e.textContent).catch(() => '');
    const modelState = () => page.$eval('[data-testid=model-controls]', (e) => e.dataset.state).catch(() => 'absent');
    const hasStore = await page.evaluate(() => window.__dotbench.model?.available ?? false);
    console.log(`METRIC 3D model store from src/device3d/customModel.ts: ${hasStore ? 'present' : 'not there yet (entry hidden, page works)'}`);

    // without a store: the entry is absent and a dropped .glb is declined politely
    await page.evaluate(() => window.__dotbench.ui.fakeModel(null));
    await page.click('[data-testid=device-menu]');
    check('model: without a model store the menu has no 3D model entry', (await modelState()) === 'absent' && !!(await page.$('[data-testid=device-export]')));
    await page.keyboard.press('Escape');
    const overlayNoStore = await drop('shell.glb');
    await sleep(200);
    check('model: without a store the drop overlay names apps only and a .glb is declined', /\.dotbench app/.test(overlayNoStore) && !/\.glb/.test(overlayNoStore) && /cannot load your own 3D model yet/.test(await noticeText()), await noticeText());

    // with a store
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'none' }));
    await page.click('[data-testid=device-menu]');
    await sleep(150);
    check('model: the Device menu shows the entry as Built-in, with one line of help and no legal copy', (await modelState()) === 'builtin' && (await page.$eval('[data-testid=model-name]', (e) => e.textContent)) === 'Built-in' && (await page.$eval('[data-testid=model-help]', (e) => e.textContent)) === 'A model you load stays in this browser; it is not uploaded.' && !/responsib|right to use|unofficial|affiliated/i.test(await page.evaluate(() => document.body.textContent)));
    check('model: the picker takes .glb files', /\.glb/.test(await page.$eval('[data-testid=model-file-input]', (e) => e.accept)));
    await page.keyboard.press('Escape');
    const overlay = await drop('shell.glb');
    await sleep(250);
    check('model: the drop overlay says what happens to each kind of file', /\.dotbench app/.test(overlay) && /\.glb 3D model/.test(overlay) && /Any other file is left alone/.test(overlay), overlay);
    check('model: a dropped .glb asks before it is used', !!(await page.$('[data-testid=model-offer]')) && (await modelState()) === 'absent' && (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'model-offer-accept');
    await page.keyboard.press('Escape');
    await sleep(150);
    check('model: Escape declines the offer and nothing changes', !(await page.$('[data-testid=model-offer]')) && (await page.evaluate(() => window.__dotbench.model.getState().status)) === 'none');
    await drop('shell.glb');
    await sleep(200);
    await page.click('[data-testid=model-offer-accept]');
    await sleep(400);
    check('model: accepting loads it, says so and names it in the menu', /shell\.glb is now the device in the 3D view/.test(await noticeText()) && (await page.evaluate(() => window.__dotbench.model.getState().status)) === 'ready', await noticeText());
    await page.click('[data-testid=device-menu]');
    await sleep(150);
    check('model: the entry shows the file name and offers the way back', (await page.$eval('[data-testid=model-name]', (e) => e.textContent)) === 'shell.glb' && !!(await page.$('[data-testid=model-reset]')));
    await page.click('[data-testid=model-reset]');
    await sleep(150);
    check('model: Back to built-in restores the built-in model', (await modelState()) === 'builtin');
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'error', name: 'bad.glb', error: 'This file is not a binary glTF.', warnings: ['Header too short.'] }));
    await sleep(150);
    check('model: an error is readable and announced', (await modelState()) === 'error' && /Could not use bad\.glb\. This file is not a binary glTF\. The built-in model is shown instead\./.test(await page.$eval('[data-testid=model-error][role=alert]', (e) => e.textContent)));
    await page.click('[data-testid=model-details]');
    check('model: the details disclosure lists the warnings', (await page.$eval('[data-testid=model-details]', (e) => e.getAttribute('aria-expanded'))) === 'true' && /Header too short/.test(await page.$eval('[data-testid=model-warnings]', (e) => e.textContent)));
    // the choices the store reports: its own shape (built-in choice + bundled file) ...
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'none', builtin: 'kode', bundled: 'ready', performance: true }));
    await sleep(150);
    const optLabels = () => page.$$eval('[data-testid=model-options] button', (els) => els.map((e) => `${e.textContent}${e.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join('|'));
    check('model: Kode model, Simple model and My own are offered, the one in use is marked', (await optLabels()) === 'Kode model*|Simple model|My own…' && (await page.$eval('[data-testid=model-name]', (e) => e.textContent)) === 'Kode model', await optLabels());
    await page.click('[data-testid=model-option-simple]');
    await sleep(150);
    check('model: choosing Simple model switches to it', (await page.evaluate(() => window.__dotbench.model.getState().builtin)) === 'simple' && (await optLabels()) === 'Kode model|Simple model*|My own…');
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'none', builtin: 'kode', bundled: 'missing', performance: true }));
    await sleep(150);
    check('model: when the bundled model is absent it is not offered and the simple one is in use', (await optLabels()) === 'Simple model*|My own…', await optLabels());
    // ... or an explicit list with the store's own labels
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'none', selected: 'b', options: [{ id: 'a', label: 'Shell A' }, { id: 'b', label: 'Shell B' }] }));
    await sleep(150);
    check('model: an explicit list from the store is shown with its labels', (await optLabels()) === 'Shell A|Shell B*', await optLabels());
    await page.evaluate(() => window.__dotbench.ui.fakeModel({ status: 'loading', name: 'big.glb' }));
    await sleep(150);
    check('model: loading is shown and the picker waits', (await modelState()) === 'loading' && (await page.$eval('[data-testid=model-pick]', (e) => e.disabled)));
    await page.keyboard.press('Escape');
    await drop('holiday.jpeg');
    await sleep(200);
    check('model: any other dropped file is declined politely, naming both kinds it accepts', /holiday\.jpeg cannot be opened here\. Drop a \.dotbench app or a \.glb 3D model\./.test(await noticeText()), await noticeText());
    await ctx.close();
  }

  check('no console errors, page errors, failed requests or HTTP errors in any phase', consoleProblems.length === 0, consoleProblems.slice(0, 5).join(' || '));

  // ================= J. layout audit: 8 viewports x 2 themes x 3 languages (scripts/layout-audit.mjs) =================
  if (process.env.AUDIT !== 'off') {
    const { audits, failures } = await runLayoutAudit(browser, { base: BASE, check });
    console.log(`METRIC layout audit: ${audits} scene audits, ${failures.length} findings`);
    for (const f of failures.slice(0, 60)) console.log(`  AUDIT ${f}`);
  }
} catch (e) {
  console.error('headless check crashed:', e);
  check('script ran to completion', false, String(e));
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
