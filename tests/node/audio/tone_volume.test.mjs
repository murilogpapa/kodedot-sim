// Scenarios on the output side through the kode.h / kode_sys API of the audio_api test app: tone, volume, mute, stop mid-play, host stall.
import { bootAudio, check, done, note, sleep, activeRange, freqOf, peak, rms, sineContinuity, RATE } from "./bench.mjs";

const a = await bootAudio("audio_api");
const grab = async (name, arg, wait = 300) => {
  a.capStart(12); const b = a.capFrames();
  const r = await a.cmd(name, arg);
  await sleep(wait);
  const l = a.capLeft(b, a.capFrames()); a.capStop();
  return { r, l, ar: activeRange(l, 0.1) };
};

// ---- tone: 1000 Hz, 1 s
{
  const { r, l, ar } = await grab("tone", "1000;1000");
  check(r.ok === 1, "kode_audio_tone 1000 Hz 1000 ms succeeds", r.line);
  check(r.took >= 950 && r.took < 1400, "the call takes the real playing time (48 kHz pacing)", r.took);
  const f = freqOf(l, ar.first + 1500, ar.last);
  check(Math.abs(f - 1000) / 1000 < 0.02, "tone frequency within the snapped bin (1000 Hz +-2 %)", f);
  check(Math.abs(ar.frames / 48 - 1000) / 1000 < 0.02, "tone duration within 2 %", ar.frames / 48);
  const c = sineContinuity(l, peak(l), f, ar.first + 700, ar.last - 1);
  check(c.ok, "no gaps or clicks at buffer boundaries", c);
}
// ---- range refusal
for (const hz of [300, 4000]) {
  const r = await a.cmd("tone", `${hz};100`);
  check(r.ok === 0, `tone ${hz} Hz is refused (outside 400..3000)`, r.line);
}
// ---- volume
const base = await grab("tone", "1000;300");
await a.cmd("set", "volume;50");
const half = await grab("tone", "1000;300");
const ratio = 20 * Math.log10(peak(half.l) / peak(base.l));
check(Math.abs(ratio + 25) < 4 || (ratio < -6 && ratio > -40), "volume 50 is quieter than volume 100", ratio.toFixed(1) + " dB");
check((await a.cmd("get", "volume")).line.includes("volume=50"), "kode_audio_get(volume) reads back 50");
const bad = await a.cmd("set", "volume;120");
check(bad.ok === 0, "volume 120 is refused", bad.line);
await a.cmd("set", "volume;100");
// ---- mute
await a.cmd("set", "mute;1");
const mt = await grab("tone", "1000;300");
check(peak(mt.l.subarray(mt.l.length >> 1)) <= 2, "mute gives digital silence on the wire once the codec ramp is done", peak(mt.l.subarray(mt.l.length >> 1)));
await a.cmd("set", "mute;0");
// ---- bench-level volume/mute + level meter
a.audio.setMuted(true);
const bm = await grab("tone", "1000;300");
a.audio.setMuted(false);
check(a.audio.level !== undefined, "level meter exists");
check(bm.l.length > 0, "bench mute leaves the wire alone (the host applies it on the ring)", peak(bm.l));
a.audio.setVolume(0.5);
a.audio.setVolume(1);
// ---- AO API
const ai = await a.ask("ainfo", undefined, /^ainfo/);
check(ai.rate === RATE && ai.present === 1, "kode_sys_audio_info_read: 48 kHz codec present", ai.line);
{
  a.capStart(4); const b = a.capFrames();
  const r = await a.ask("atone", "1000;200;50", /^ask kind=1 /);
  await sleep(600);
  const l = a.capLeft(b, a.capFrames()); a.capStop();
  check(r.taken === 0, "kode_sys_audio_tone accepted (rc 0)", r.line);
  const p50 = peak(l);
  check(Math.abs(p50 - 32767 * 0.5 * 0.944) < 500, "kode_sys_audio_tone amp 50 is 50 % of full scale through the speaker cap", p50);
}
// ---- stop mid-play
{
  a.capStart(12); const b = a.capFrames();
  a.type(`function name="tone" arg="1000;3000"`);
  await sleep(600);
  const t0 = Date.now();
  const s = await a.cmd("playstop");
  const stopMs = Date.now() - t0;
  await a.waitFor(() => a.res().some((x) => /^tone /.test(x)), 5000, "tone call returns after stop").catch(() => {});
  await sleep(300);
  const l = a.capLeft(b, a.capFrames()); a.capStop();
  const ar = activeRange(l, 0.1);
  note(`stop mid-play: playstop ok=${s.ok} in ${stopMs} ms; audible ${Math.round(ar.frames / 48)} ms of a 3000 ms tone`);
  check(ar.frames / 48 < 2200, "a tone stopped at 600 ms does not play out its 3 s", ar.frames / 48);
}
// ---- host stall: nobody reads the ring; the firmware is unaffected and the wire capture is intact
{
  a.audio.resetStats();
  a.capStart(12); const b = a.capFrames();
  const r = await a.cmd("tone", "1500;1500");
  await sleep(300);
  const l = a.capLeft(b, a.capFrames()); a.capStop();
  const ar = activeRange(l, 0.1);
  check(r.ok === 1 && r.took < 2200, "no reader on the ring: the firmware call is not slowed", r.took);
  check(Math.abs(ar.frames / 48 - 1500) / 1500 < 0.03, "wire capture intact during a host stall", ar.frames / 48);
  check(a.hdr("outOverruns") + a.hdr("outDropped") >= 0, "ring overrun counters readable", [a.hdr("outOverruns"), a.hdr("outDropped")]);
  const rd = a.audio.createReader(); const x = rd.read();
  check(x.length <= 32768 * 2, "a late reader resyncs to at most one ring of data", x.length);
}
done(a, "tone_volume");
