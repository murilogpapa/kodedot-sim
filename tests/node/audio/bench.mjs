// Shared helpers of the audio tests: boot an app, attach the real glue (runtime/drivers/audio/audio.js as packaged in the
// .dotbench) the way the browser adapter does, drive the audio_api console functions, capture the wire, analyse sound.
import { pathToFileURL } from "node:url";
import { boot, pkgPath, sleep } from "../harness.mjs";

export { pkgPath, sleep };
export const RATE = 48000;
let failures = 0;
export function check(cond, what, detail) {
  if (cond) console.log("ok   - " + what + (detail !== undefined && process.env.VERBOSE ? "  [" + JSON.stringify(detail) + "]" : ""));
  else { failures++; console.log("FAIL - " + what + (detail !== undefined ? "  [" + (typeof detail === "string" ? detail : JSON.stringify(detail)) + "]" : "")); }
}
export const note = (s) => console.log("note - " + s);
export const failed = () => failures;
export function done(a, name) {
  console.log(name + ": " + (failures ? `FAILED (${failures})` : "PASSED"));
  if (a) a.shutdown();
  process.exit(failures ? 1 : 0);
}

/** Boot `pkg` (an app under build/apps) with the audio glue attached. */
export async function bootAudio(pkg) {
  const a = await boot(pkgPath(pkg));
  const M = a.M, ticks = [], events = [];
  const ctx = {
    module: M, statePtr: a.statePtr, u32: a.u32, i32: a.i32, setU32: a.setU32,
    call: (name, ...args) => M["_" + name](...args),
    alloc: (n) => M._malloc(n), free: (p) => M._free(p), heap: () => M.HEAPU8,
    emit: (type, data) => events.push({ type, ...data }),
    onTick: (cb) => ticks.push(cb),
  };
  const mod = await import(pathToFileURL(a.dir + "/glue/audio/audio.js").href);
  const audio = mod.default(ctx);
  const timer = setInterval(() => ticks.forEach((cb) => cb()), 20);
  const shutdown = a.shutdown;
  a.shutdown = () => { clearInterval(timer); shutdown(); };
  a.audio = audio; a.events = events; a.glue = mod;
  a.hdr = (name) => new DataView(M.HEAPU8.buffer).getUint32(audio.sharedPtr + mod.LAYOUT[name], true);

  // ---- console ----
  a.type = (line) => {
    const b = Buffer.from(line + "\n"), p = M._malloc(b.length + 1);
    M.HEAPU8.set(b, p); M._kweb_console_input(p, b.length); M._free(p);
  };
  const resLines = () => a.logText().split("\n").map((l) => l.trim()).filter((l) => l.includes("RES "));
  a.res = () => resLines().map((l) => l.slice(l.indexOf("RES ") + 4));
  /** Type a function call and wait for its RES line; returns {line, ...key=value}. */
  a.cmd = async (name, arg, ms = 20000) => {
    const before = a.res().length;
    a.type(`function name="${name}"` + (arg === undefined ? "" : ` arg=${JSON.stringify(String(arg))}`));
    const t0 = Date.now(), re = new RegExp("^" + name + "\\b");
    for (;;) {
      const hit = a.res().slice(before).find((l) => re.test(l) || l === "busy");
      if (hit) return parseRes(hit);
      if (Date.now() - t0 > ms) throw new Error(`no RES ${name} after ${ms} ms; got ${JSON.stringify(a.res().slice(before))}\n${a.logText().slice(-1500)}`);
      await sleep(10);
    }
  };
  /** Type a function call that is answered by a later RES line matching `re` (the AO calls). */
  a.ask = async (name, arg, re, ms = 20000) => {
    const before = a.res().length;
    a.type(`function name="${name}"` + (arg === undefined ? "" : ` arg=${JSON.stringify(String(arg))}`));
    const t0 = Date.now();
    for (;;) {
      const hit = a.res().slice(before).find((l) => re.test(l));
      if (hit) return parseRes(hit);
      if (Date.now() - t0 > ms) throw new Error(`no RES matching ${re} after ${ms} ms; got ${JSON.stringify(a.res().slice(before))}`);
      await sleep(10);
    }
  };
  a.logHas = (re) => re.test(a.logText());
  await a.waitFor(() => a.logText().includes(pkg === "audio_api" ? "audio_api up" : "up; the top button plays a note"), 30000, "app boot");

  // ---- the wire capture (what the I2S transmitter clocked out, stereo int16) ----
  a.capStart = (seconds) => M._audio_cap_start(Math.round(seconds * RATE));
  a.capStop = () => M._audio_cap_stop();
  a.capFrames = () => M._audio_cap_frames();
  /** Left channel of the capture as Float64Array/Int16Array (copy). */
  a.capLeft = (from = 0, to = a.capFrames()) => {
    const p = M._audio_cap_ptr(), st = new Int16Array(M.HEAPU8.buffer.slice(p + from * 4, p + to * 4)), l = new Int16Array(to - from);
    for (let i = 0; i < l.length; i++) l[i] = st[2 * i];
    return l;
  };
  a.capStereo = (from = 0, to = a.capFrames()) => { const p = M._audio_cap_ptr(); return new Int16Array(M.HEAPU8.buffer.slice(p + from * 4, p + to * 4)); };
  /** Collect the output ring through the glue's reader on a 5 ms timer. */
  a.sink = () => {
    const rd = audio.createReader(), parts = [];
    const t = setInterval(() => { const x = rd.read(); if (x.length) parts.push(x); }, 5);
    return { reader: rd, stop() { clearInterval(t); const x = rd.read(); if (x.length) parts.push(x); let n = 0; for (const p of parts) n += p.length; const all = new Int16Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } return all; } };
  };
  /** Read an int16 mono recording the app left in memory (RES recsamples ... addr=). */
  a.mem16 = (addr, frames) => new Int16Array(M.HEAPU8.buffer.slice(addr, addr + frames * 2));
  return a;
}

export function parseRes(line) {
  const o = { line };
  for (const m of line.matchAll(/(\w+)=("[^"]*"|\S*)/g)) { const v = m[2]; o[m[1]] = /^-?\d+$/.test(v) ? Number(v) : v; }
  const first = line.split(/\s/)[0]; o.name = first;
  return o;
}

// ------------------------------------------------------------------------------------------------ signal analysis
export function peak(x, a = 0, b = x.length) { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i])); return p; }
export function rms(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
/** First and last index whose |x| exceeds frac * peak (the audible part of a sound). */
export function activeRange(x, frac = 0.1) {
  const t = peak(x) * frac; let first = -1, last = -1;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > t) { if (first < 0) first = i; last = i; }
  return { first, last, frames: first < 0 ? 0 : last - first + 1 };
}
/** Frequency by interpolated rising zero crossings over [a, b). Accurate to ~1e-4 for a clean tone. */
export function freqOf(x, a = 0, b = x.length) {
  const cross = [];
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) cross.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  if (cross.length < 3) return 0;
  return ((cross.length - 1) * RATE) / (cross[cross.length - 1] - cross[0]);
}
/** Largest sample-to-sample step in [a, b), and where. */
export function maxStep(x, a = 1, b = x.length) {
  let m = 0, at = -1;
  for (let i = Math.max(1, a); i < b; i++) { const d = Math.abs(x[i] - x[i - 1]); if (d > m) { m = d; at = i; } }
  return { step: m, at };
}
/**
 * Continuity of a sine of known amplitude and frequency in [a, b): the biggest step must not exceed the sine's own biggest step
 * (A * 2 sin(pi f / fs)) by more than `slack`, and there must be no run of exact zeros longer than `maxZeros` (a gap).
 * Returns {ok, step, limit, zeroRun}.
 */
export function sineContinuity(x, amp, hz, a, b, slack = 1.25, maxZeros = 3) {
  const limit = amp * 2 * Math.sin((Math.PI * hz) / RATE) * slack + 2;
  const { step, at } = maxStep(x, a + 1, b);
  let run = 0, worst = 0;
  for (let i = a; i < b; i++) { if (x[i] === 0) { run++; worst = Math.max(worst, run); } else run = 0; }
  return { ok: step <= limit && worst <= maxZeros, step, at, limit, zeroRun: worst };
}
/** Left channel of an interleaved stereo int16 array. */
export function left(st) { const l = new Int16Array(st.length >> 1); for (let i = 0; i < l.length; i++) l[i] = st[2 * i]; return l; }
/** The WAV bytes of mono 16-bit samples at any rate / channels (for feeding the file source). */
export function makeWav(samples, rate = RATE, channels = 1) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + 2 * i);
  return b;
}
