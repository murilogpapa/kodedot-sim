// Headless Chrome test of the audio area's browser half: glue + AudioWorklet over the shared output ring, under the
// strict CSP of tests/browser/server.mjs and cross-origin isolation. It does not boot the wasm firmware (that is the
// Node suite's job): the page plays the part of the firmware's producer and writes the documented ring layout into a
// SharedArrayBuffer, so what is proved here is: frames reach the worklet and the speaker graph, bench volume and mute act,
// the blocked-until-gesture state is reported and resumes with a real click, and nothing throws.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { CSP } from "./server.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const drv = path.resolve(here, "../../runtime/drivers/audio");
const require = createRequire(import.meta.url);
let puppeteer;
for (const p of ["puppeteer-core", path.join(here, "../../web/node_modules/puppeteer-core"), "/home/claude/dotbench/web/node_modules/puppeteer-core"]) { try { puppeteer = require(p); break; } catch {} }
if (!puppeteer) throw new Error("puppeteer-core not found (npm i puppeteer-core in tests/browser, or set NODE_PATH)");

const PAGE_JS = `
import glue from "/drv/audio.js";
const BASE = 0x1000, OUT = 0x100, FR = 32768;
const sab = new SharedArrayBuffer(BASE + OUT + FR * 4 + 0x10000);
const u32 = new Uint32Array(sab), i16 = new Int16Array(sab), heap = new Uint8Array(sab);
const H = (off) => (BASE + off) >> 2;
u32[H(0)] = 0x4455414b; u32[H(4)] = 1; u32[H(0x10)] = OUT; u32[H(0x14)] = FR; u32[H(0x18)] = 48000; u32[H(0x1c)] = 2;
const events = [];
const ctx = { module: {}, heap: () => heap, emit: (type, d) => events.push({ type, ...d }), onTick: (cb) => { window.__tick = cb; },
  call: (name, ...a) => { if (name === "audio_shared_ptr") return BASE; if (name === "audio_bench_set") { Atomics.store(u32, H(0x60), a[0]); Atomics.store(u32, H(0x64), a[1]); } return 0; } };
const api = glue(ctx);
let ph = 0;
function push(frames, hz, amp) {
  const wr = Atomics.load(u32, H(0x20));
  for (let i = 0; i < frames; i++) { const v = Math.round(amp * Math.sin(2 * Math.PI * hz * (ph++) / 48000)); const k = ((wr + i) % FR) * 2 + ((BASE + OUT) >> 1); i16[k] = v; i16[k + 1] = v; }
  Atomics.store(u32, H(0x20), (wr + frames) >>> 0);
}
let feeder = null;
window.T = {
  api, events, isolated: crossOriginIsolated,
  start(hz = 1000, amp = 12000) { clearInterval(feeder); feeder = setInterval(() => { const q = (Atomics.load(u32, H(0x20)) - Atomics.load(u32, H(0x24))) >>> 0; if (q < 4800) push(960, hz, amp); }, 10); },
  stop() { clearInterval(feeder); },
  hdr: (off) => Atomics.load(u32, H(off)),
  async spectrum() {
    const an = api.getAnalyser(); const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
    let k = 0; for (let i = 1; i < f.length; i++) if (f[i] > f[k]) k = i;
    return { hz: k * an.context.sampleRate / an.fftSize, db: f[k] };
  },
  async offline() {   // OfflineAudioContext: render the worklet over a pre-filled ring and read the samples back
    const oac = new OfflineAudioContext(2, 9600, 48000);
    await oac.audioWorklet.addModule(location.origin + "/drv/audio-worklet.js");
    // pre-fill the ring (the reader starts after the worklet's prebuffer, so give it plenty)
    u32[H(0x24)] = 0; u32[H(0x20)] = 0; ph = 0;
    const n = new AudioWorkletNode(oac, "dotbench-audio-out", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { buffer: sab, base: BASE, latencyMs: 50 } });
    push(11000, 1000, 10000);   // the processor starts reading at "now" (its construction), so write after it exists; <= 5 x the 50 ms target or it skips ahead
    n.connect(oac.destination);
    const buf = await oac.startRendering();
    return Array.from(buf.getChannelData(0));
  },
};
window.TREADY = true;
`;
const PAGE = `<!doctype html><meta charset=utf-8><title>audio</title><body><button id=b>go</button><script type=module src="/page.js"></script>`;

function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const h = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": CSP, "Cache-Control": "no-store" };
    let body, type = "text/javascript";
    if (u.pathname === "/" || u.pathname === "/index") { body = PAGE; type = "text/html"; }
    else if (u.pathname === "/page.js") body = PAGE_JS;
    else if (u.pathname.startsWith("/drv/")) { const f = path.join(drv, path.basename(u.pathname)); if (fs.existsSync(f)) body = fs.readFileSync(f); }
    if (body === undefined) { res.writeHead(404, h); res.end("nf"); return; }
    res.writeHead(200, { ...h, "Content-Type": type }); res.end(body);
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, url: "http://127.0.0.1:" + srv.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const { srv, url } = await serve();
async function session(args, fn) {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", ...args] });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(url + "/");
  page.__cdp = await page.createCDPSession();
  // puppeteer's page.evaluate runs with a user gesture (which would lift the autoplay block); this one does not
  page.ev = async (fn, ...args) => {
    const r = await page.__cdp.send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: false });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await until(page, () => window.TREADY === true, 15000, "the page to load").catch((e) => { console.log("page errors:", errors); throw e; });
  try { await fn(page, errors); } finally { await browser.close(); }
}
const check = async (name, fn) => { try { await fn(); console.log("ok   - " + name); } catch (e) { failed = true; console.log("FAIL - " + name + "\n" + (e.stack ?? e)); } };
// polls through the gesture-free evaluate (puppeteer's waitForFunction would count as a user activation)
async function until(page, fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await page.ev(fn)) return; } catch { /* page not ready */ } await sleep(50); }
  throw new Error("timeout waiting for " + what);
}
const WORKLET = () => location.origin + "/drv/audio-worklet.js";

// ---------- 1. autoplay allowed: frames reach the worklet and the speaker graph
await session(["--autoplay-policy=no-user-gesture-required"], async (page, errors) => {
  await check("page is cross-origin isolated, strict CSP, glue and worklet module load", async () => {
    assert.equal(await page.ev(() => T.isolated), true);
    const st = await page.ev(async (u) => { const r = await T.api.attachOutput({ workletUrl: location.origin + "/drv/audio-worklet.js" }); return r; }, null);
    assert.equal(st, "running");
  });
  await check("a tone written to the ring reaches the AudioWorklet: analyser sees 1 kHz, sink_rms and state report it", async () => {
    await page.ev(() => T.start(1000, 12000));
    await until(page, () => T.hdr(0x78) > 1000, 8000, "sink rms > 0");
    await sleep(400);
    const s = await page.ev(() => T.spectrum());
    assert.ok(Math.abs(s.hz - 1000) < 60, "spectral peak " + s.hz + " Hz");
    assert.ok(s.db > -60, "level " + s.db + " dB");
    assert.equal(await page.ev(() => T.hdr(0x70)), 1, "sinkState running");
    const rms = await page.ev(() => T.hdr(0x78));
    assert.ok(rms > 12000 / Math.SQRT2 * 0.7 && rms < 12000 / Math.SQRT2 * 1.3, "sink rms " + rms + " is near 8485");
    const lat = await page.ev(() => T.api.output.latencyMs);
    console.log("note - output latency estimate " + lat + " ms (50 ms worklet prebuffer + context)");
  });
  await check("bench mute silences the worklet, unmute restores it; bench volume scales it", async () => {
    await page.ev(() => T.api.setMuted(true));
    await until(page, () => T.hdr(0x78) === 0, 4000, "sink rms 0 while muted");
    await page.ev(() => { T.api.setMuted(false); T.api.setVolume(1); });
    await until(page, () => T.hdr(0x78) > 1000, 4000, "sink rms back");
    const full = await page.ev(() => T.hdr(0x78));
    await page.ev(() => T.api.setVolume(0.5));
    await sleep(500);
    const half = await page.ev(() => T.hdr(0x78));
    assert.ok(half < full * 0.8 && half > 0, `volume 0.5: rms ${half} < ${full}`);
    await page.ev(() => T.api.setVolume(1));
  });
  await check("a stalled producer starves the worklet (counted), then it recovers", async () => {
    await page.ev(() => T.stop());
    await until(page, () => T.hdr(0x7c) > 0 || T.hdr(0x70) === 2, 4000, "starved");
    await page.ev(() => T.start(1000, 12000));
    await until(page, () => T.hdr(0x78) > 1000, 4000, "recovered");
  });
  await check("detach then re-attach works, no page errors", async () => {
    await page.ev(() => T.stop());
    await page.ev(() => T.api.detachOutput());
    assert.equal(await page.ev(() => T.api.output.state), "detached");
    assert.equal(await page.ev(() => T.api.attachOutput({ workletUrl: location.origin + "/drv/audio-worklet.js" })), "running");
    assert.deepEqual(errors, []);
  });
  await check("OfflineAudioContext renders the worklet over a pre-filled ring: 1 kHz at the written amplitude", async () => {
    const x = await page.ev(() => T.offline());
    let pk = 0, nz = 0; for (const v of x) { pk = Math.max(pk, Math.abs(v)); if (v !== 0) nz++; }
    assert.ok(nz > x.length * 0.9, "non-zero samples " + nz + " of " + x.length);
    assert.ok(Math.abs(pk - 10000 / 32768) < 0.02, "peak " + pk);
  });
});

// ---------- 2. autoplay NOT allowed: blocked until a gesture, then a real click resumes
await session(["--autoplay-policy=document-user-activation-required"], async (page, errors) => {
  await check("without a user gesture the output reports 'blocked' with the documented message and never throws", async () => {
    await page.ev(() => T.api.attachOutput({ workletUrl: location.origin + "/drv/audio-worklet.js" }));
    assert.equal(await page.ev(() => T.api.output.state), "blocked");
    assert.equal(await page.ev(() => T.api.output.message), "audio blocked until the user interacts");
    assert.equal(await page.ev(() => T.hdr(0x70)), 3, "sinkState blocked");
    assert.deepEqual(errors, []);
  });
  await check("a real click resumes the context: state becomes running and audio reaches the worklet", async () => {
    await page.ev(() => T.start(1000, 12000));
    await page.click("#b");
    await until(page, () => T.api.output.state === "running", 5000, "running after the click");
    await until(page, () => T.hdr(0x78) > 1000, 5000, "sink rms after the click");
    assert.deepEqual(errors, []);
  });
});

srv.close();
console.log(failed ? "audio browser test: FAILED" : "audio browser test: PASSED");
process.exit(failed ? 1 : 0);
