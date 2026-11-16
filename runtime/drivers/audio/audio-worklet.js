// SPDX-License-Identifier: GPL-3.0-or-later
// AudioWorklet processors of the audio area. ONE file, two lives:
//  * in the AudioWorkletGlobalScope (audioWorklet.addModule(url)) it registers "dotbench-audio-out" (the speaker: reads the
//    firmware's output ring in shared memory and renders it) and "dotbench-audio-in" (the host microphone: writes the input
//    ring the firmware's recording reads);
//  * on the main thread (the adapter imports every packaged glue file) it only records its own URL in
//    globalThis.__dotbenchAudioWorkletUrl, which audio.js hands to addModule(). The URL is a blob: URL made by the adapter, so
//    it loads under `script-src 'self' blob:`; a page that serves this file itself passes {workletUrl} to attachOutput().
// No fetch, no importScripts, no eval: nothing the page's CSP forbids. SharedArrayBuffer arrives in processorOptions (the page is
// cross-origin isolated).
//
// Ring protocol (audio_shared.h): out_wr is the producer's running frame count, out_rd the consumer's. This processor never
// makes the producer wait: if it is lapped (wr - rd > capacity) or more than 5x the latency target is queued, it skips forward
// to `target` frames behind the newest and counts the loss in out_dropped. It starts playing once `target` frames are queued
// (latencyMs, default 50) and goes silent (and re-buffers) when the ring runs dry; a dry ring while the firmware was still
// writing counts as an underrun (sink_underruns). Silence between sounds needs no data: the ring is simply empty.

const NAME_OUT = "dotbench-audio-out";
const NAME_IN = "dotbench-audio-in";

if (typeof registerProcessor === "function") {
  // header word indices (byte offset / 4), mirroring audio_shared.h
  const W = {
    outOff: 0x10 >> 2, outFrames: 0x14 >> 2, outWr: 0x20 >> 2, outRd: 0x24 >> 2, outDropped: 0x28 >> 2, outBlocks: 0x34 >> 2,
    benchGain: 0x60 >> 2, benchMute: 0x64 >> 2, sinkState: 0x70 >> 2, sinkPeak: 0x74 >> 2, sinkRms: 0x78 >> 2, sinkUnder: 0x7c >> 2,
    inOff: 0xa4 >> 2, inCap: 0xa8 >> 2, inWr: 0xac >> 2,
  };
  const RUNNING = 1, STARVED = 2;

  class DotbenchAudioOut extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { buffer, base, latencyMs = 50 } = options.processorOptions;
      this.h = new Uint32Array(buffer, base, 64);
      this.frames = this.h[W.outFrames];
      this.data = new Int16Array(buffer, base + this.h[W.outOff], this.frames * 2);
      this.mask = this.frames - 1;
      this.ratio = 48000 / sampleRate;                       // source frames per output frame
      this.target = Math.max(256, Math.round(latencyMs * 48));
      this.max = this.target * 5;
      this.rd = Atomics.load(this.h, W.outWr) >>> 0;         // start at "now": old data is not played
      this.frac = 0;
      this.running = false;
      this.gain = 0;
      this.lastBlocks = Atomics.load(this.h, W.outBlocks);
      this.lastBlocksAt = -1;
      this.under = 0;
      this.dropped = 0;
    }

    process(inputs, outputs) {
      const out = outputs[0], L = out[0], R = out.length > 1 ? out[1] : null, n = L.length, h = this.h;
      const wr = Atomics.load(h, W.outWr) >>> 0;
      let fill = (wr - this.rd) >>> 0;
      if (fill > this.frames || (this.running && fill > this.max)) {                   // lapped, or too much latency: skip ahead
        const keep = Math.min(this.target, fill);
        this.dropped += fill - keep;
        Atomics.store(h, W.outDropped, (Atomics.load(h, W.outDropped) + (fill - keep)) >>> 0);
        this.rd = (wr - keep) >>> 0; fill = keep; this.frac = 0;
      }
      const blocks = Atomics.load(h, W.outBlocks);
      if (blocks !== this.lastBlocks) { this.lastBlocks = blocks; this.lastBlocksAt = currentTime; }
      const need = Math.ceil(n * this.ratio) + 2;
      if (!this.running && fill >= this.target) this.running = true;
      if (this.running && fill < need) {                                               // ran dry
        this.running = false;
        if (this.lastBlocksAt >= 0 && currentTime - this.lastBlocksAt < 0.1) { this.under++; Atomics.store(h, W.sinkUnder, this.under); }
      }
      if (!this.running) {
        L.fill(0); if (R) R.fill(0);
        Atomics.store(h, W.sinkState, STARVED); Atomics.store(h, W.sinkPeak, 0); Atomics.store(h, W.sinkRms, 0);
        this.gain = 0;
        return true;
      }
      const g1 = Atomics.load(h, W.benchMute) ? 0 : Atomics.load(h, W.benchGain) / 65536 / 32768, g0 = this.gain;
      const data = this.data, mask = this.mask, ratio = this.ratio;
      let pos = this.frac, peak = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const k = Math.floor(pos), f = pos - k, a = ((this.rd + k) & mask) * 2, b = ((this.rd + k + 1) & mask) * 2;
        const g = g0 + (g1 - g0) * ((i + 1) / n);
        const l = (data[a] * (1 - f) + data[b] * f) * g, r = (data[a + 1] * (1 - f) + data[b + 1] * f) * g;
        L[i] = l; if (R) R[i] = r;
        const m = Math.abs(l); if (m > peak) peak = m; sum += l * l;
        pos += ratio;
      }
      const adv = Math.floor(pos);
      this.rd = (this.rd + adv) >>> 0; this.frac = pos - adv; this.gain = g1;
      Atomics.store(h, W.outRd, this.rd);
      Atomics.store(h, W.sinkState, RUNNING);
      Atomics.store(h, W.sinkPeak, Math.min(32768, Math.round(peak * 32768)));
      Atomics.store(h, W.sinkRms, Math.min(32768, Math.round(Math.sqrt(sum / n) * 32768)));
      return true;
    }
  }

  class DotbenchAudioIn extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { buffer, base } = options.processorOptions;
      this.h = new Uint32Array(buffer, base, 64);
      this.cap = this.h[W.inCap];
      this.ring = new Int16Array(buffer, base + this.h[W.inOff], this.cap);
      this.step = sampleRate / 48000;                        // input frames per 48 kHz frame
      this.pos = 0;
    }

    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (!ch) return true;
      const h = this.h, mask = this.cap - 1;
      let wr = Atomics.load(h, W.inWr) >>> 0;
      for (; this.pos < ch.length; this.pos += this.step) {
        const k = Math.floor(this.pos), f = this.pos - k, v = ch[k] * (1 - f) + (k + 1 < ch.length ? ch[k + 1] : ch[k]) * f;
        this.ring[wr & mask] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        wr = (wr + 1) >>> 0;
      }
      this.pos -= ch.length;
      Atomics.store(h, W.inWr, wr);
      return true;
    }
  }

  registerProcessor(NAME_OUT, DotbenchAudioOut);
  registerProcessor(NAME_IN, DotbenchAudioIn);
} else {
  globalThis.__dotbenchAudioWorkletUrl = import.meta.url;
}

/** Imported as glue by the adapter: nothing to expose (audio.js is the area's API). */
export default function () { return null; }
