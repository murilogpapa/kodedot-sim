// SPDX-License-Identifier: GPL-3.0-or-later
// JS glue of the audio area (packaged as glue/audio/audio.js; the AudioWorklet processor is audio-worklet.js).
//
//   const audio = device.area("audio");           // null while nothing runs
//   audio.attachOutput();                         // speaker: AudioContext + AudioWorklet fed from the shared ring
//   audio.output.state                            // "detached" | "blocked" | "running" | "unsupported" | "error" | "closed"
//   audio.resume();                               // call from a click/keypress handler when state is "blocked"
//   audio.setVolume(0.5); audio.setMuted(true);   // the bench's own volume and mute (the SDK's are the firmware's)
//   audio.level()                                 // {peak, rms, peakDb, rmsDb}: for the page's meter
//   audio.input.setSynth({ kind: "tone", hz: 440, levelDb: -20 }); audio.input.setSource("synth");
//   await audio.input.setFile(arrayBuffer);       // WAV decoded here, any rate/channels/width -> 48 kHz mono
//   await audio.input.useMic();                   // getUserMedia, only when called (explicit permission request)
//
// Events (device.on("area:audio:<type>", cb)): "output-state" {state, message}, "playing" {playing}, "underrun" {count},
// "input-state" {source, state, message}, "error" {where, message}. Full typings: audio.d.ts. Shared-memory layout:
// audio_shared.h (LAYOUT below mirrors it; tests/node/audio/layout.test.mjs checks the two against the C build).
//
// Nothing here throws into the page: failures become `state: "error"`/"unsupported" plus an "error" event.
// Under Node (no Web Audio) only the ring reader, the WAV decoder and the input controls are usable: see OutputRingReader.

export const RATE = 48000;
export const BLOCKED_MESSAGE = "audio blocked until the user interacts";

/** Byte offsets into kaud_shared_t (audio_shared.h). */
export const LAYOUT = Object.freeze({
  magic: 0x00, version: 0x04, size: 0x08, flags: 0x0c,
  outOff: 0x10, outFrames: 0x14, outRate: 0x18, outChannels: 0x1c, outWr: 0x20, outRd: 0x24, outDropped: 0x28, outOverruns: 0x2c,
  outActiveMs: 0x30, outBlocks: 0x34, outFramesTotal: 0x38, outUnderruns: 0x3c, outGapFrames: 0x40, outLates: 0x44,
  outGainQ16: 0x48, outCodecMute: 0x4c, levelPeak: 0x50, levelRms: 0x54, levelSeq: 0x58, levelMs: 0x5c,
  benchGainQ16: 0x60, benchMute: 0x64, toleranceFrames: 0x68, pace: 0x6c,
  sinkState: 0x70, sinkPeak: 0x74, sinkRms: 0x78, sinkUnderruns: 0x7c,
  inSource: 0x80, inSynthKind: 0x84, inSynthHz: 0x88, inSynthLevel: 0x8c, inFileFrames: 0x90, inFileLoop: 0x94, inFilePtr: 0x98,
  inRewind: 0x9c, inRewindAuto: 0xa0, inOff: 0xa4, inFramesCap: 0xa8, inWr: 0xac, inRd: 0xb0, inUnderruns: 0xb4, inDropped: 0xb8,
  inFrames: 0xbc, inGainDbX10: 0xc0, inMuted: 0xc4, inSessions: 0xc8, inLevelPeak: 0xcc, inLevelRms: 0xd0, inClip: 0xd4,
  inPos: 0xd8, inActiveMs: 0xdc,
  OUT_DATA: 0x100,
});
export const FLAGS = Object.freeze({ TX_RUN: 1, RX_RUN: 2, OPEN: 4, PRESENT: 8, MIC_DENIED: 16 });
const SRC = { silence: 0, synth: 1, file: 2, mic: 3 };
const SRC_NAME = ["silence", "synth", "file", "mic"];
const SINK = { none: 0, running: 1, starved: 2, blocked: 3 };

const u32 = (n) => n >>> 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

// ------------------------------------------------------------------------------------------------ WAV decoding
/**
 * Decode a WAV file (PCM 8/16/24/32 bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) to mono 48 kHz int16.
 * Channels are averaged; other rates are resampled (linear interpolation, with a box pre-filter when decimating).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{samples: Int16Array, sourceRate: number, sourceChannels: number, sourceBits: number, seconds: number}}
 */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= u8.length;) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true), rate = dv.getUint32(body + 4, true), bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);   // extensible: the sub-format's first word
      fmt = { format, channels, rate, bits };
    } else if (id === "data") {
      data = { start: body, len: Math.min(size, u8.length - body) };
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  const { format, channels, rate, bits } = fmt;
  if (channels < 1 || rate < 1) throw new Error("WAV header is invalid");
  const bps = bits >> 3;
  const okPcm = format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32);
  const okFloat = format === 3 && (bits === 32 || bits === 64);
  if (!okPcm && !okFloat) throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bits)`);
  const frames = Math.floor(data.len / (bps * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = data.start + (i * channels + c) * bps;
      let v;
      if (format === 3) v = bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      else if (bits === 8) v = (u8[o] - 128) / 128;
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) v = ((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8 >> 8) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      acc += v;
    }
    mono[i] = acc / channels;
  }
  const out = resampleTo48k(mono, rate);
  const samples = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) samples[i] = Math.round(clamp(out[i], -1, 1) * 32767);
  return { samples, sourceRate: rate, sourceChannels: channels, sourceBits: bits, seconds: frames / rate };
}

/** Linear-interpolation resampler to 48 kHz (a box average first when the source rate is higher). @param {Float32Array} x */
export function resampleTo48k(x, rate) {
  if (rate === RATE) return x;
  let src = x;
  if (rate > RATE) {                                   // crude anti-alias: average over the decimation window
    const w = Math.max(1, Math.round(rate / RATE));
    if (w > 1) {
      src = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        let s = 0, n = 0;
        for (let k = -(w >> 1); k < w - (w >> 1); k++) { const j = i + k; if (j >= 0 && j < x.length) { s += x[j]; n++; } }
        src[i] = s / n;
      }
    }
  }
  const n = Math.floor((x.length * RATE) / rate), y = new Float32Array(n), step = rate / RATE;
  for (let i = 0; i < n; i++) {
    const p = i * step, i0 = Math.floor(p), f = p - i0;
    y[i] = src[i0] * (1 - f) + (i0 + 1 < src.length ? src[i0 + 1] : src[i0]) * f;
  }
  return y;
}

// ------------------------------------------------------------------------------------------------ ring reader
/**
 * The consumer side of the output ring, for hosts without an AudioWorklet (Node tests, a main-thread fallback). Takes the
 * wasm memory's buffer (a SharedArrayBuffer under pthreads) and the address from audio_shared_ptr().
 * read() returns the frames written since the last call as interleaved stereo int16; lapped data is skipped and counted.
 */
export class OutputRingReader {
  constructor(buffer, base) {
    this.hdr = new Uint32Array(buffer, base, LAYOUT.OUT_DATA / 4);
    this.frames = this.hdr[LAYOUT.outFrames >> 2];
    this.data = new Int16Array(buffer, base + this.hdr[LAYOUT.outOff >> 2], this.frames * 2);
    this.rd = Atomics.load(this.hdr, LAYOUT.outWr >> 2);      // start at "now"
    this.dropped = 0;
    this.reset = () => { this.rd = Atomics.load(this.hdr, LAYOUT.outWr >> 2); Atomics.store(this.hdr, LAYOUT.outRd >> 2, this.rd); };
  }
  /** Frames waiting. */
  available() { return u32(Atomics.load(this.hdr, LAYOUT.outWr >> 2) - this.rd); }
  /** @param {number} [max] @returns {Int16Array} interleaved stereo */
  read(max = this.frames) {
    const mask = this.frames - 1;
    let wr = u32(Atomics.load(this.hdr, LAYOUT.outWr >> 2)), lag = u32(wr - this.rd);
    if (lag > this.frames) { this.dropped += lag - this.frames; this.rd = u32(wr - this.frames); lag = this.frames; }
    const n = Math.min(lag, max), out = new Int16Array(n * 2), start = this.rd;
    for (let i = 0; i < n; i++) { const k = ((start + i) & mask) * 2; out[2 * i] = this.data[k]; out[2 * i + 1] = this.data[k + 1]; }
    wr = u32(Atomics.load(this.hdr, LAYOUT.outWr >> 2));                  // torn if the producer lapped us meanwhile
    if (u32(wr - start) > this.frames) { this.dropped += n; this.rd = u32(start + n); Atomics.store(this.hdr, LAYOUT.outRd >> 2, this.rd); return new Int16Array(0); }
    this.rd = u32(start + n);
    Atomics.store(this.hdr, LAYOUT.outRd >> 2, this.rd);
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ module state
// The page-owned settings live in the module so they survive a restart of the program (the glue is recreated at every boot).
const keep = {
  volume: 1, muted: false, toleranceMs: null,
  source: "silence", synth: { kind: "tone", hz: 1000, levelDb: -20 }, file: null, fileLoop: true, rewindAuto: true,
  audioContext: null, workletUrl: null,
};

/**
 * The glue. `ctx` is the adapter's area context (see docs/DRIVER-AREA-GUIDE.md section 6).
 * @param {any} ctx
 */
export default function (ctx) {
  const M = ctx.module;
  const base = ctx.call("audio_shared_ptr");
  const hdr = new Uint32Array(ctx.heap().buffer, base, LAYOUT.OUT_DATA / 4);
  const hdrI = new Int32Array(ctx.heap().buffer, base, LAYOUT.OUT_DATA / 4);
  const ld = (off) => Atomics.load(hdr, off >> 2);
  const st = (off, v) => Atomics.store(hdr, off >> 2, v >>> 0);
  const ldI = (off) => Atomics.load(hdrI, off >> 2);
  const emit = (type, data) => { try { ctx.emit(type, data); } catch { /* a listener's problem */ } };
  const err = (where, e) => emit("error", { where, message: String(e?.message ?? e) });
  if (ld(LAYOUT.magic) !== 0x4455414b) throw new Error("audio: shared block magic mismatch");

  // ---- output ------------------------------------------------------------------------------------------------
  const out = { state: "detached", message: "", latencyMs: 0, sampleRate: 0, contextState: "none" };
  let ac = null, node = null, analyser = null, tickers = [], gestureCleanup = null;
  const setState = (state, message = "") => {
    if (out.state === state && out.message === message) return;
    out.state = state; out.message = message;
    emit("output-state", { state, message });
  };
  const applyBench = () => {
    const g = Math.round(clamp(keep.volume, 0, 1) ** 2 * 65536);   // perceptual taper: the slider is amplitude-squared
    ctx.call("audio_bench_set", g, keep.muted ? 1 : 0);
  };
  const syncState = () => {
    if (!ac) return;
    out.contextState = ac.state;
    if (ac.state === "running") { st(LAYOUT.sinkState, ld(LAYOUT.sinkState) === SINK.blocked ? SINK.running : ld(LAYOUT.sinkState)); setState("running", ""); }
    else if (ac.state === "closed") setState("closed", "the AudioContext was closed");
    else { st(LAYOUT.sinkState, SINK.blocked); setState("blocked", BLOCKED_MESSAGE); }
  };
  const removeGestureHooks = () => { if (gestureCleanup) { gestureCleanup(); gestureCleanup = null; } };
  const installGestureHooks = (target) => {
    if (gestureCleanup || !target?.addEventListener) return;
    const evs = ["pointerdown", "keydown", "touchend", "mousedown"];
    const h = () => { resume(); };
    for (const e of evs) target.addEventListener(e, h, { capture: true });
    gestureCleanup = () => { for (const e of evs) target.removeEventListener(e, h, { capture: true }); };
  };

  async function resume() {
    if (!ac) return out.state;
    try { await ac.resume(); } catch (e) { err("resume", e); }
    syncState();
    if (out.state === "running") removeGestureHooks();
    return out.state;
  }

  /**
   * Create (or reuse) the AudioContext and the output AudioWorklet. Never throws. Resolves to the output state: "running", or
   * "blocked" when the browser wants a user gesture first (a one-shot listener on `gestureTarget` then resumes by itself).
   * @param {{audioContext?: AudioContext, workletUrl?: string, latencyMs?: number, gestureTarget?: EventTarget|null,
   *          destination?: AudioNode}} [opts]
   */
  async function attachOutput(opts = {}) {
    try {
      if (node) await detachOutput();
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC || !globalThis.AudioWorkletNode) { setState("unsupported", "this browser has no AudioWorklet"); return out.state; }
      ac = opts.audioContext ?? keep.audioContext;
      if (!ac || ac.state === "closed") {
        try { ac = new AC({ sampleRate: RATE, latencyHint: "interactive" }); } catch { ac = new AC({ latencyHint: "interactive" }); }
      }
      keep.audioContext = ac;
      const url = opts.workletUrl ?? keep.workletUrl ?? globalThis.__dotbenchAudioWorkletUrl;
      if (!url) throw new Error("no worklet URL: pass opts.workletUrl (the audio-worklet.js module)");
      keep.workletUrl = url;
      if (!ac.__dotbenchModule) { await ac.audioWorklet.addModule(url); ac.__dotbenchModule = true; }
      out.sampleRate = ac.sampleRate;
      node = new AudioWorkletNode(ac, "dotbench-audio-out", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { buffer: ctx.heap().buffer, base, latencyMs: opts.latencyMs ?? 50 },
      });
      node.onprocessorerror = (e) => { err("worklet", e?.message ?? "processor error"); setState("error", "the audio worklet failed"); };
      analyser = ac.createAnalyser(); analyser.fftSize = 2048;
      node.connect(analyser);
      node.connect(opts.destination ?? ac.destination);
      out.latencyMs = Math.round(((opts.latencyMs ?? 50) + (ac.baseLatency ?? 0) * 1000 + (ac.outputLatency ?? 0) * 1000));
      ac.onstatechange = syncState;
      syncState();
      if (out.state === "blocked") {
        const gt = opts.gestureTarget === undefined ? globalThis.document : opts.gestureTarget;
        installGestureHooks(gt);
        try { await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 150))]); } catch { /* blocked: stays so */ }
        syncState();
      }
    } catch (e) {
      err("attachOutput", e);
      setState("error", String(e?.message ?? e));
    }
    return out.state;
  }

  async function detachOutput() {
    removeGestureHooks();
    try { node?.disconnect(); analyser?.disconnect(); } catch { /* already gone */ }
    node = null; analyser = null;
    if (ac) ac.onstatechange = null;
    st(LAYOUT.sinkState, SINK.none);
    setState("detached", "");
  }

  /** The analyser attached behind the worklet (for a page scope or the browser test); null while detached. */
  const getAnalyser = () => analyser;

  // ---- meter and activity, driven by the adapter's 20 ms tick ----------------------------------------------------
  const meter = { peak: 0, rms: 0, source: "codec" };
  let lastSeq = ld(LAYOUT.levelSeq), lastSeqAt = 0, playing = false, lastUnder = ld(LAYOUT.sinkUnderruns), lastOutUnder = ld(LAYOUT.outUnderruns);
  const nowMs = () => (globalThis.performance?.now?.() ?? Date.now());
  function tick() {
    const t = nowMs(), seq = ld(LAYOUT.levelSeq);
    const benchGain = keep.muted ? 0 : clamp(keep.volume, 0, 1) ** 2;
    if (seq !== lastSeq) { lastSeq = seq; lastSeqAt = t; }
    const fresh = t - lastSeqAt < 120;
    let peak = fresh ? ld(LAYOUT.levelPeak) / 32768 * benchGain : 0, rms = fresh ? ld(LAYOUT.levelRms) / 32768 * benchGain : 0, src = "codec";
    if (node && out.state === "running" && ld(LAYOUT.sinkState) !== SINK.none) { peak = ld(LAYOUT.sinkPeak) / 32768; rms = ld(LAYOUT.sinkRms) / 32768; src = "sink"; }
    meter.peak = Math.max(peak, meter.peak * 0.85); meter.rms = rms; meter.source = src;
    if (meter.peak < 1e-4) meter.peak = 0;
    const nowPlaying = fresh && ld(LAYOUT.levelPeak) > 0;
    if (nowPlaying !== playing) { playing = nowPlaying; emit("playing", { playing }); }
    const su = ld(LAYOUT.sinkUnderruns), ou = ld(LAYOUT.outUnderruns);
    if (su !== lastUnder || ou !== lastOutUnder) { lastUnder = su; lastOutUnder = ou; emit("underrun", { count: su + ou, sink: su, wire: ou }); }
    for (const f of tickers) f();
  }
  ctx.onTick(tick);

  // ---- bench output controls -----------------------------------------------------------------------------------
  applyBench();
  if (keep.toleranceMs != null) ctx.call("audio_set_tolerance_ms", keep.toleranceMs);

  // ---- input ------------------------------------------------------------------------------------------------
  const inp = { source: "silence", state: "ok", message: "" };
  let capCtx = null, capNode = null, micStream = null;
  const inEmit = (state, message = "") => { inp.state = state; inp.message = message; emit("input-state", { source: inp.source, state, message }); };

  function setSource(name) {
    const k = SRC[name];
    if (k === undefined) throw new RangeError(`unknown source "${name}" (silence, synth, file, mic)`);
    if (name !== "mic") { Atomics.and(hdr, LAYOUT.flags >> 2, ~FLAGS.MIC_DENIED); }
    ctx.call("audio_in_source", k);
    inp.source = name; keep.source = name;
    inEmit("ok", "");
    return name;
  }
  /** Synthetic source. `levelDb` is dBFS peak at the codec's nominal microphone gain (24 dB, the SDK's default). */
  function setSynth({ kind = keep.synth.kind, hz = keep.synth.hz, levelDb = keep.synth.levelDb } = {}) {
    keep.synth = { kind: kind === "noise" ? "noise" : "tone", hz: clamp(Math.round(hz), 1, 23999), levelDb: Math.min(0, levelDb) };
    ctx.call("audio_in_synth", keep.synth.kind === "noise" ? 1 : 0, keep.synth.hz, Math.round(clamp(10 ** (keep.synth.levelDb / 20), 0, 1) * 32767));
    return { ...keep.synth };
  }
  /** Install a WAV file as the "file" source (decoded here). Resolves to {frames, seconds, sourceRate, ...}; rejects on a bad WAV. */
  async function setFile(data, { loop = true } = {}) {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
    const dec = decodeWav(bytes);
    uploadFile(dec.samples, loop);
    keep.file = { pcm: dec.samples, info: { ...dec, samples: undefined } };
    return { frames: dec.samples.length, seconds: dec.samples.length / RATE, sourceRate: dec.sourceRate, sourceChannels: dec.sourceChannels, sourceBits: dec.sourceBits };
  }
  function uploadFile(pcm, loop) {
    const p = ctx.call("audio_in_file_begin", pcm.length);
    if (!p) throw new Error("no memory for the file");
    new Uint8Array(ctx.heap().buffer, p, pcm.length * 2).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.length * 2));
    ctx.call("audio_in_file_commit", loop ? 1 : 0);
    keep.fileLoop = !!loop;
  }
  function clearFile() { ctx.call("audio_in_file_clear"); keep.file = null; }
  function rewind() { ctx.call("audio_in_rewind"); }
  /** true (default): every recording starts the source (file, tone phase) from its beginning; false: the source runs on continuously. */
  function setRewindOnRecord(on) { keep.rewindAuto = !!on; ctx.call("audio_in_rewind_auto", on ? 1 : 0); }

  /** Feed the microphone ring from JS (what the capture worklet does): mono int16 or float [-1,1]. Returns the frames accepted. */
  function feedMic(samples) {
    const f = samples instanceof Int16Array ? samples : Int16Array.from(samples, (v) => Math.round(clamp(v, -1, 1) * 32767));
    const cap = ld(LAYOUT.inFramesCap), ring = new Int16Array(ctx.heap().buffer, base + ld(LAYOUT.inOff), cap);
    const wr = ld(LAYOUT.inWr);
    for (let i = 0; i < f.length; i++) ring[(wr + i) & (cap - 1)] = f[i];
    Atomics.store(hdr, LAYOUT.inWr >> 2, u32(wr + f.length));
    return f.length;
  }

  /**
   * Use the host microphone as the source. Asks the browser for permission NOW (call it from a click). Resolves to the input
   * state: "ok" or "denied" (the SDK's recording calls then fail, as with a denied permission) or "unavailable"/"error".
   */
  async function useMic() {
    try {
      const md = globalThis.navigator?.mediaDevices;
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!md?.getUserMedia || !AC || !globalThis.AudioWorkletNode) { setSource("silence"); inEmit("unavailable", "this browser cannot capture the microphone"); return inp.state; }
      stopMicCapture();
      const url = keep.workletUrl ?? globalThis.__dotbenchAudioWorkletUrl;
      if (!url) throw new Error("no worklet URL: attach the output first or set one with setWorkletUrl()");
      try {
        micStream = await md.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) {
        inp.source = "mic"; keep.source = "mic";
        ctx.call("audio_in_source", SRC.mic);
        Atomics.or(hdr, LAYOUT.flags >> 2, FLAGS.MIC_DENIED);
        inEmit("denied", String(e?.name ?? e));
        return inp.state;
      }
      capCtx = keep.audioContext && keep.audioContext.state !== "closed" ? keep.audioContext : new AC({ sampleRate: RATE });
      keep.audioContext = capCtx;
      if (!capCtx.__dotbenchModule) { await capCtx.audioWorklet.addModule(url); capCtx.__dotbenchModule = true; }
      const src = capCtx.createMediaStreamSource(micStream);
      capNode = new AudioWorkletNode(capCtx, "dotbench-audio-in", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { buffer: ctx.heap().buffer, base },
      });
      const mute = capCtx.createGain(); mute.gain.value = 0;
      src.connect(capNode); capNode.connect(mute); mute.connect(capCtx.destination);
      capNode.__src = src; capNode.__mute = mute;
      if (capCtx.state === "suspended") { try { await capCtx.resume(); } catch { /* needs a gesture */ } }
      Atomics.and(hdr, LAYOUT.flags >> 2, ~FLAGS.MIC_DENIED);
      setSource("mic");
    } catch (e) {
      err("useMic", e);
      stopMicCapture();
      inEmit("error", String(e?.message ?? e));
    }
    return inp.state;
  }
  function stopMicCapture() {
    try { capNode?.__src?.disconnect(); capNode?.disconnect(); capNode?.__mute?.disconnect(); } catch { /* gone */ }
    capNode = null;
    try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    micStream = null;
  }
  function stopMic() { stopMicCapture(); if (inp.source === "mic") setSource("silence"); }

  // restore what the page chose before a restart (the microphone is not re-requested)
  setSynth(keep.synth);
  ctx.call("audio_in_rewind_auto", keep.rewindAuto ? 1 : 0);
  if (keep.file) uploadFile(keep.file.pcm, keep.fileLoop);
  setSource(keep.source === "mic" ? "silence" : keep.source);

  // ---- statistics ---------------------------------------------------------------------------------------------
  function stats() {
    return {
      flags: ld(LAYOUT.flags),
      codec: { open: !!(ld(LAYOUT.flags) & FLAGS.OPEN), gain: ld(LAYOUT.outGainQ16) / 65536, muted: !!ld(LAYOUT.outCodecMute), micGainDb: ldI(LAYOUT.inGainDbX10) / 10 + 24, micMuted: !!ld(LAYOUT.inMuted) },
      output: {
        blocks: ld(LAYOUT.outBlocks), frames: ld(LAYOUT.outFramesTotal), underruns: ld(LAYOUT.outUnderruns), gapFrames: ld(LAYOUT.outGapFrames),
        lates: ld(LAYOUT.outLates), overruns: ld(LAYOUT.outOverruns), dropped: ld(LAYOUT.outDropped), sinkUnderruns: ld(LAYOUT.sinkUnderruns),
        queued: u32(ld(LAYOUT.outWr) - ld(LAYOUT.outRd)),
      },
      input: {
        source: SRC_NAME[ld(LAYOUT.inSource)] ?? "silence", frames: ld(LAYOUT.inFrames), sessions: ld(LAYOUT.inSessions), underruns: ld(LAYOUT.inUnderruns),
        dropped: ld(LAYOUT.inDropped), clipped: ld(LAYOUT.inClip), fileFrames: ld(LAYOUT.inFileFrames),
      },
    };
  }
  function level() {
    const peak = meter.peak, rms = meter.rms;
    return { peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms), playing, source: meter.source };
  }

  // ---- the public object -----------------------------------------------------------------------------------------
  const input = {
    /** "silence" | "synth" | "file" | "mic" */
    get source() { return inp.source; },
    /** "ok" | "denied" (mic permission refused) | "unavailable" | "error" */
    get state() { return inp.state; },
    get message() { return inp.message; },
    setSource, setSynth, setFile, clearFile, rewind, setRewindOnRecord, useMic, stopMic, feedMic,
  };
  return {
    /** The speaker's state: {state: "detached"|"blocked"|"running"|"unsupported"|"error"|"closed", message, latencyMs, sampleRate}. */
    output: out,
    /** The microphone's bench source and its controls. */
    input,
    attachOutput, detachOutput, resume, getAnalyser,
    /** Declare where audio-worklet.js is served from (same origin or blob:) before attachOutput() or useMic(). */
    setWorkletUrl(u) { keep.workletUrl = u; },
    /** Bench volume 0..1 (amplitude-squared taper) and mute: independent of the firmware's own volume/mute. */
    setVolume(v) { keep.volume = clamp(Number(v) || 0, 0, 1); applyBench(); },
    setMuted(m) { keep.muted = !!m; applyBench(); },
    get volume() { return keep.volume; },
    get muted() { return keep.muted; },
    /** How far behind the I2S clock the firmware may fall before it counts as an underrun (ms, 30..2000; default 200). */
    setUnderrunTolerance(ms) { keep.toleranceMs = clamp(Math.round(ms), 30, 2000); ctx.call("audio_set_tolerance_ms", keep.toleranceMs); },
    /** true (default) throttles the firmware at 48 kHz; false lets it run free (only for tests that do not care about time). */
    setPacing(on) { ctx.call("audio_set_pacing", on ? 1 : 0); },
    level, stats,
    get playing() { return playing; },
    /** Firmware-side state: the DAC gain the chip applies now and whether register 0x31 mutes it. */
    codec() { const s = stats().codec; return { gain: s.gain, muted: s.muted, open: s.open }; },
    resetStats() { ctx.call("audio_stats_reset"); },
    /** A consumer of the output ring for hosts without a worklet. */
    createReader() { return new OutputRingReader(ctx.heap().buffer, base); },
    tick,
    sharedPtr: base,
    layout: LAYOUT,
  };
}
