// The shared-memory layout: the JS mirror (LAYOUT) against the C build, the worklet's constants against LAYOUT, the area's
// header contract (magic, ring geometry, defaults), the ring reader on synthetic producer sequences (wrap, lapped, torn).
import fs from "node:fs";
import { bootAudio, check, done } from "./bench.mjs";
import { OutputRingReader, LAYOUT, decodeWav } from "../../../runtime/drivers/audio/audio.js";

const a = await bootAudio("audio_api");
const M = a.M, p = M._audio_shared_ptr();
check(M._audio_layout(0) === a.hdr("size"), "kaud_shared_t size in the header equals sizeof (C)", a.hdr("size"));
check(a.hdr("magic") === 0x4455414b && a.hdr("version") === 1, "magic KAUD and version 1");
check(M._audio_layout(1) === LAYOUT.OUT_DATA && a.hdr("outOff") === LAYOUT.OUT_DATA, "output ring data at 0x100");
check(a.hdr("outFrames") === M._audio_layout(4) && (a.hdr("outFrames") & (a.hdr("outFrames") - 1)) === 0, "output ring capacity is a power of two", a.hdr("outFrames"));
check(a.hdr("inOff") === M._audio_layout(2) && a.hdr("inFramesCap") === M._audio_layout(5), "input ring offset and capacity match C");
check(a.hdr("outRate") === 48000 && a.hdr("outChannels") === 2, "output format: 48000 Hz, 2 slots");
check(a.hdr("benchGainQ16") === 65536 && a.hdr("pace") === 1 && a.hdr("toleranceFrames") === 9600, "defaults: bench gain unity, pacing on, tolerance 200 ms");
check(a.hdr("inSource") === 0, "default microphone source is silence");
// the JS offsets that matter at runtime are exercised by every other test; here the worklet's own copy is checked against LAYOUT
const w = fs.readFileSync(new URL("../../../runtime/drivers/audio/audio-worklet.js", import.meta.url), "utf8");
const win = (n) => { const m = w.match(new RegExp(n + ":\\s*(0x[0-9a-f]+)\\s*>>\\s*2")); return m ? Number(m[1]) : null; };
for (const [wn, ln] of [["outOff", "outOff"], ["outFrames", "outFrames"], ["outWr", "outWr"], ["outRd", "outRd"], ["outDropped", "outDropped"], ["outBlocks", "outBlocks"],
  ["benchGain", "benchGainQ16"], ["benchMute", "benchMute"], ["sinkState", "sinkState"], ["sinkPeak", "sinkPeak"], ["sinkRms", "sinkRms"],
  ["sinkUnder", "sinkUnderruns"], ["inOff", "inOff"], ["inCap", "inFramesCap"], ["inWr", "inWr"]])
  check(win(wn) === LAYOUT[ln], `worklet word ${wn} == LAYOUT.${ln} (0x${LAYOUT[ln].toString(16)})`, win(wn));
check(/dotbench-audio-out/.test(w) && /dotbench-audio-in/.test(w), "worklet registers the output and the input processor");
check(!/\b(eval|importScripts|fetch|XMLHttpRequest)\s*\(|new Function/.test(w.replace(/\/\/.*$/gm, "")), "worklet uses no eval/importScripts/fetch (CSP-clean)");

// ---- the reader on a synthetic producer: a private header + ring in a SharedArrayBuffer, no firmware involved
function makeRing(frames) {
  const sab = new SharedArrayBuffer(0x100 + frames * 4 + 64);
  const h = new Uint32Array(sab, 0, 64);
  h[LAYOUT.outOff >> 2] = 0x100; h[LAYOUT.outFrames >> 2] = frames;
  const data = new Int16Array(sab, 0x100, frames * 2);
  const push = (arr) => {   // producer: stereo frames then release store of wr
    let wr = Atomics.load(h, LAYOUT.outWr >> 2);
    for (let i = 0; i < arr.length; i++) { const k = ((wr + i) & (frames - 1)) * 2; data[k] = arr[i]; data[k + 1] = -arr[i]; }
    Atomics.store(h, LAYOUT.outWr >> 2, (wr + arr.length) >>> 0);
  };
  return { sab, h, push, reader: new OutputRingReader(sab, 0) };
}
{
  const { reader, push } = makeRing(1024);
  const seq = Int16Array.from({ length: 700 }, (_, i) => i + 1);
  push(seq.subarray(0, 300)); const x1 = reader.read();
  push(seq.subarray(300, 700)); const x2 = reader.read();
  const all = [...x1, ...x2];
  check(x1.length === 600 && x2.length === 800 && all.every((v, i) => (i % 2 === 0 ? v === (i >> 1) + 1 : v === -((i >> 1) + 1))), "reader returns every frame in order across a wrap-free sequence, both slots");
}
{
  const { reader, push } = makeRing(1024);
  for (let r = 0; r < 5; r++) { push(Int16Array.from({ length: 600 }, (_, i) => r * 600 + i + 1)); const x = reader.read(); if (r === 0) continue; if (x[0] !== r * 600 + 1) { check(false, "wraparound order", [r, x[0]]); } }
  check(true, "reader stays in order while the ring wraps (5 x 600 frames through 1024)");
}
{
  const { reader, push, h } = makeRing(1024);
  push(Int16Array.from({ length: 3000 }, (_, i) => i + 1));                 // 3000 > 1024: lapped
  const x = reader.read();
  check(reader.dropped === 3000 - 1024 && x.length === 2048 && x[0] === 3000 - 1024 + 1, "a lapped reader skips to the newest full ring and counts the loss", { dropped: reader.dropped, n: x.length, first: x[0] });
  check(Atomics.load(h, LAYOUT.outRd >> 2) === 3000, "the reader publishes out_rd");
}
{
  const { reader, h } = makeRing(1024);
  Atomics.store(h, LAYOUT.outWr >> 2, 0xfffffff0);          // counters wrap at 2^32
  const r2 = new OutputRingReader(reader.hdr.buffer, 0);
  r2.rd = 0xfffffff0;
  const wrapPush = (n) => { let wr = Atomics.load(h, LAYOUT.outWr >> 2); for (let i = 0; i < n; i++) { const k = ((wr + i) & 1023) * 2; r2.data[k] = 5; r2.data[k + 1] = 5; } Atomics.store(h, LAYOUT.outWr >> 2, (wr + n) >>> 0); };
  wrapPush(40);
  check(r2.available() === 40 && r2.read().length === 80 && r2.available() === 0, "frame counters wrap at 2^32 without losing frames");
}

// ---- WAV decoder
{
  const mk = (rate, ch, bits, fmt, frames) => {
    const bps = bits / 8, dataLen = frames * ch * bps, b = Buffer.alloc(44 + dataLen);
    b.write("RIFF", 0); b.writeUInt32LE(36 + dataLen, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(fmt, 20); b.writeUInt16LE(ch, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * bps, 28); b.writeUInt16LE(ch * bps, 32); b.writeUInt16LE(bits, 34); b.write("data", 36); b.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) { const v = Math.sin(i * 0.05) * (c ? 0.5 : 1) * 0.8, o = 44 + (i * ch + c) * bps;
      if (fmt === 3) b.writeFloatLE(v, o); else if (bits === 16) b.writeInt16LE(Math.round(v * 32767), o); else if (bits === 8) b.writeUInt8(Math.round(v * 127 + 128), o); else if (bits === 24) { const q = Math.round(v * 8388607); b.writeIntLE(q, o, 3); } }
    return b;
  };
  const d16 = decodeWav(mk(48000, 1, 16, 1, 4800));
  check(d16.samples.length === 4800 && d16.sourceRate === 48000, "48 kHz mono 16-bit WAV decodes unchanged in length");
  const d441 = decodeWav(mk(44100, 2, 16, 1, 44100));
  check(Math.abs(d441.samples.length - 48000) <= 1 && d441.sourceChannels === 2, "44.1 kHz stereo resamples to 48 kHz mono (1 s -> 48000 frames)", d441.samples.length);
  const d8 = decodeWav(mk(48000, 1, 8, 1, 100)), d24 = decodeWav(mk(48000, 1, 24, 1, 100)), df = decodeWav(mk(48000, 1, 32, 3, 100));
  check(d8.samples.length === 100 && d24.samples.length === 100 && df.samples.length === 100, "8, 24-bit PCM and float32 WAV decode");
  const peakDiff = Math.abs(Math.max(...d24.samples) - Math.max(...df.samples));
  check(peakDiff <= 3, "24-bit and float32 paths agree on the same waveform", peakDiff);
  let threw = 0; for (const bad of [Buffer.from("nope"), Buffer.alloc(44)]) { try { decodeWav(bad); } catch { threw++; } }
  check(threw === 2, "garbage is rejected with an exception from decodeWav (and never reaches the firmware)");
}
done(a, "layout");
