// Shared helpers for the UX screenshot script (ux-shots.mjs) and the layout audit (layout-audit.mjs).
// Starts (or reuses) a `vite preview` of dist/, opens pages at the review viewports and drives the page into named scenes.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.UX_PORT ?? 4390);
export const BASE = `http://localhost:${PORT}/?debug`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The review matrix. `touch` viewports are emulated as touch devices (coarse pointer). */
export const VIEWPORTS = [
  { id: '1920x1080', w: 1920, h: 1080 },
  { id: '1440x900', w: 1440, h: 900 },
  { id: '1280x720', w: 1280, h: 720 },
  { id: '1024x768', w: 1024, h: 768, touch: true, tablet: true },
  { id: '820x1180', w: 820, h: 1180, touch: true, tablet: true },
  { id: '390x844', w: 390, h: 844, touch: true, phone: true },
  { id: '360x740', w: 360, h: 740, touch: true, phone: true },
  { id: '844x390', w: 844, h: 390, touch: true, phone: true },
];
export const LANGS = ['en', 'pt-BR', 'es'];
export const THEMES = ['light', 'dark'];

export async function startServer() {
  const up = async () => {
    try {
      return (await fetch(BASE)).ok;
    } catch {
      return false;
    }
  };
  if (await up()) return { kill() {} };
  const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 75; i++) {
    if (await up()) return server;
    await sleep(200);
  }
  server.kill();
  throw new Error('preview server did not start');
}

export const launch = () =>
  puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });

export async function until(fn, ms = 30000, step = 60) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await sleep(step);
  }
}

const statusOf = (page) => page.evaluate(() => window.__dotbench?.device().status.get());
const colours = (page) =>
  page.evaluate(() => {
    const c = window.__dotbench?.painter?.canvas ?? document.querySelector('[data-testid=screen-canvas]');
    if (!c) return 99; // 3D view on a build without the painter hook: trust the status
    const d = c.getContext('2d').getImageData(0, 0, 410, 502).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 13) set.add(d[i] | (d[i + 1] << 8) | (d[i + 2] << 16));
    return set.size;
  });
export const waitRunning = (page, ms = 45000) => until(async () => (await statusOf(page)) === 'running' && (await colours(page)) > 5, ms);

/**
 * Opens the page at a viewport. opts: { theme, lang, view ('3d'|'2d'), zoom (1|2|3|'fit'), mock, prefs: {key: value}, isolate: false to strip COOP/COEP }.
 * Returns { ctx, page, vp, problems }.
 */
export async function openPage(browser, vp, opts = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: opts.dpr ?? 1, isMobile: !!vp.touch, hasTouch: !!vp.touch });
  const prefs = { 'dotbench.lang': opts.lang ?? 'en', 'dotbench.theme': opts.theme ?? 'light', ...(opts.prefs ?? {}) };
  if (opts.view) prefs[vp.phone ? 'dotbench.view.phone' : 'dotbench.view'] = opts.view;
  if (opts.zoom) prefs['dotbench.zoom2d'] = opts.zoom;
  if (opts.mock) prefs['dotbench.mock'] = true;
  await page.evaluateOnNewDocument((p) => {
    if (sessionStorage.getItem('ux-seeded')) return;
    sessionStorage.setItem('ux-seeded', '1');
    for (const [k, v] of Object.entries(p)) localStorage.setItem(k, JSON.stringify(v));
  }, prefs);
  if (opts.isolate === false) {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.isNavigationRequest() && req.resourceType() === 'document') {
        const r = await fetch(req.url());
        const headers = Object.fromEntries([...r.headers].filter(([k]) => !/^cross-origin-(opener|embedder)-policy$/i.test(k)));
        req.respond({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
      } else req.continue();
    });
  }
  await page.goto(opts.base ?? BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__dotbench, { timeout: 30000 });
  return { ctx, page, vp, problems };
}

export const has = (page, sel) => page.$(sel).then((e) => !!e);
export async function clickIf(page, sel) {
  const el = await page.$(sel);
  if (!el) return false;
  await el.evaluate((e) => e.click());
  return true;
}

/** Long, realistic firmware output: wrapped words, ISO timestamps, long paths, a prompt. */
export async function fillConsole(page, n = 60) {
  await page.evaluate((count) => {
    const log = window.__dotbench.device().log;
    const iso = (i) => `2026-11-16T19:${String(10 + (i % 50)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String((i * 37) % 1000).padStart(3, '0')}Z`;
    const samples = [
      (i) => ['info', `${iso(i)} [kode_sys] (main) boot: kode-sdk c9568a3, LVGL 9.6.0, heap 4194304 bytes free`],
      (i) => ['info', `${iso(i)} [display] kscreen_flush area=(0,0)-(409,501) px=205820 took 3.2 ms backlight=100`],
      (i) => ['warn', `${iso(i)} [wifi] kode_wifi_connect("CasaDoMurilo_5G_Sala_de_Estar"): no router in range, retry ${i} in 2000 ms`],
      (i) => ['error', `${iso(i)} [nvs] /Users/dev/kode-sdk/components/kode_sys/src/storage/kode_nvs_backend_littlefs.c:412 assert failed: handle != NULL`],
      (i) => ['debug', `${iso(i)} [touch] down x=205 y=251 pressure=0.82 id=0 0xDEADBEEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF`],
      () => ['input', 'help'],
      () => ['info', 'kode> !I commands: help, reboot, heap, tasks, log <level>, nvs get <ns> <key>, nvs set <ns> <key> <value>'],
    ];
    for (let i = 0; i < count; i++) {
      const [level, text] = samples[i % samples.length](i);
      log.push(level, text, Date.now() - (count - i) * 1000);
    }
  }, n);
  await sleep(150);
}

export async function forceStatus(page, status, reason) {
  await page.evaluate(
    ([s, r]) => {
      const d = window.__dotbench.device();
      d._detail?.set(r ? { status: s, reason: r } : { status: s });
      d._status?.set(s);
      if (!d._status) d.status.set?.(s);
    },
    [status, reason],
  );
  await sleep(150);
}

export async function dropOverlay(page, on = true) {
  await page.evaluate((show) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'my_app.dotbench'));
    window.dispatchEvent(new DragEvent(show ? 'dragenter' : 'dragleave', { dataTransfer: dt, bubbles: true }));
  }, on);
  await sleep(250);
}

/** Uploads user apps (copies of a real example with long and short names). Leaves the last one running. */
export async function addUserApps(page, reopen = async () => {}, names = ['weather_station_dashboard_with_a_very_long_file_name_v2.dotbench', 'blink.dotbench']) {
  const src = join(root, 'public/apps/buttons_led.dotbench');
  mkdirSync('/tmp/ux-apps', { recursive: true });
  for (const n of names) {
    const p = join('/tmp/ux-apps', n);
    copyFileSync(src, p);
    if (!(await page.$('[data-testid=file-input]'))) await reopen(); // the picker closes once an app was chosen
    const input = await page.$('[data-testid=file-input]');
    if (!input) throw new Error('file input not found (open the apps list first)');
    await input.uploadFile(p);
    await until(async () => (await page.evaluate(() => window.__dotbench.device().status.get())) === 'running', 20000);
    await sleep(300);
  }
}

export async function shot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}
