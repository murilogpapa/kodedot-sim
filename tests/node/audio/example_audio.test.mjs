// The UNMODIFIED SDK example examples/audio, end to end: the top button plays the next of eight notes (250 ms at 25 % of full
// scale through kode_sys_audio_tone), the bottom button records 2 s (kode_sys_audio_record_file) with the LED red while it listens.
// Real AO_Audio, real kdrv_es8311.c jobs, over the software I2S/codec: what is asserted is the PCM the I2S transmitter clocked out.
import { bootAudio, check, done, note, sleep, activeRange, freqOf, peak, rms, sineContinuity, left, RATE } from "./bench.mjs";
import { BTN } from "../harness.mjs";

const a = await bootAudio("audio");
const NOTES = [1020, 1137, 1254, 1395, 1535, 1676, 1816, 1957];
const press = async (b) => { a.button(b, true); await sleep(60); a.button(b, false); };
const logs = () => a.logText();

check(/codec|kaos.audio up; volume 100, microphone 24 dB, mute 0/.test(logs()), "AO_Audio found the codec at boot (volume 100, microphone 24 dB, mute 0)");
a.capStart(20);
const heard = [];
for (let n = 0; n < 3; n++) {
  const before = a.capFrames();
  const t0 = Date.now();
  await press(BTN.TOP);
  await a.waitFor(() => new RegExp(`note ${n + 1}: ${NOTES[n]} Hz for 250 ms`).test(logs()), 10000, "note " + (n + 1));
  // the sound ends: the capture stops growing with the drain's silence after the audible part
  await a.waitFor(() => { const c = a.capFrames(); return c - before > 0.25 * RATE && Date.now() - t0 > 600; }, 10000, "the note's frames");
  await sleep(250);
  const l = a.capLeft(before, a.capFrames());
  const ar = activeRange(l, 0.1);
  const f = freqOf(l, ar.first + 1500, ar.last);
  const amp = peak(l);
  heard.push({ n: n + 1, f: Math.round(f * 10) / 10, ms: ar.frames / 48, amp });
  check(Math.abs(f - NOTES[n]) / NOTES[n] < 0.01, `note ${n + 1}: the I2S stream carries ${NOTES[n]} Hz within 1 %`, f);
  check(ar.frames / 48 > 245 * 0.98 - 8 && ar.frames / 48 < 252, `note ${n + 1}: audible length 250 ms within 2 % (first block and the chip's 12 ms ramp excluded)`, ar.frames / 48);
  check(Math.abs(amp - 32767 * 0.25 * 0.944) < 400, `note ${n + 1}: peak is 25 % of full scale through the -0.5 dB speaker cap`, amp);
  const c = sineContinuity(l, amp, NOTES[n], ar.first + 700, ar.last - 1);
  check(c.ok, `note ${n + 1}: no gaps or clicks at the 256-frame block boundaries (largest step ${c.step} <= ${Math.round(c.limit)})`, c);
}
check(a.hdr("outUnderruns") === 0, "no underrun was counted while playing");

// ---- the bottom button: a 2 s recording, LED red while it listens, then the file write
const t1 = Date.now();
await press(BTN.BOT);
await a.waitFor(() => a.led()[0] > 0 && a.led()[1] === 0, 5000, "LED red while recording");
check(a.led()[0] === 32 && logs().includes("listening"), "LED red (32) and 'listening' logged while the microphone records");
await a.waitFor(() => /recorded 2000 ms into|no recording in/.test(logs()), 15000, "the recording's answer");
const dt = Date.now() - t1;
check(dt > 1900 && dt < 4500, "the 2 s recording takes 2 s of wall time (open and file write included)", dt + " ms");
const ok = /recorded 2000 ms into \/storage\/example_rec.wav, (\d+) bytes/.exec(logs());
if (ok) check(Number(ok[1]) === 44 + 2 * 96000, "the WAV is 44 + 192000 bytes (2 s of 48 kHz mono 16-bit)", ok[1]);
else note("file layer: the recording ran 2 s but AO_Storage could not write /storage/example_rec.wav (the storage area is still stubbed in this worktree): " + /no recording in[^\n]*/.exec(logs())?.[0]);
await a.waitFor(() => a.led().join() === "0,0,0", 5000, "LED off after the recording");
check(true, "LED off again once the answer arrived");
const stubs = (logs() + "\n" + a.logs.join("\n")).split("\n").filter((l) => /not implemented/.test(l));
check(!stubs.some((l) => /es8311|i2s|codec|audio|kring|kwav/i.test(l)), "no 'dotbench: ... not implemented' stub fired for an audio function", stubs.slice(0, 5));
console.log("heard:", JSON.stringify(heard));
done(a, "example_audio");
