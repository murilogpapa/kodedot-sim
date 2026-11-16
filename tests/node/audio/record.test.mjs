// Input side: synthetic sources, silence, mic ring, pacing without drift, mic gain.
import { bootAudio, check, done, note, sleep, peak, rms, freqOf, RATE } from "./bench.mjs";

const a = await bootAudio("audio_api");
const rec = async (ms) => { const t0 = Date.now(); const r = await a.cmd("recsamples", String(ms), ms + 8000); return { r, wall: Date.now() - t0, x: r.ok ? a.mem16(r.addr, r.frames) : new Int16Array(0) }; };

// silence (default)
{
  const { r, wall, x } = await rec(1000);
  check(r.ok === 1 && r.frames === RATE, "1 s recording returns 48000 frames", r.line);
  check(wall >= 950 && wall < 1500, "recording is paced at the real rate", wall);
  check(peak(x) <= 2, "default source is silence", peak(x));
}
// synthetic tone
a.audio.input.setSynth({ kind: "tone", hz: 1000, levelDb: -20 });
a.audio.input.setSource("synth");
{
  const { x } = await rec(1000);
  const f = freqOf(x, 2000, x.length), p = peak(x);
  check(Math.abs(f - 1000) < 15, "synthetic tone source: frequency 1000 Hz", f);
  check(p > 1500 && p < 15000, "synthetic tone source: level follows the setting", p);
}
// noise
a.audio.input.setSynth({ kind: "noise", levelDb: -20 });
{
  const { x } = await rec(500);
  check(rms(x) > 100, "noise source has energy", rms(x));
}
// mic ring (feedMic)
a.audio.input.setSource("mic");
{
  const feed = new Int16Array(RATE); for (let i = 0; i < feed.length; i++) feed[i] = Math.round(8000 * Math.sin(2 * Math.PI * 700 * i / RATE));
  const t = setInterval(() => a.audio.input.feedMic(feed.subarray(0, 960)), 20);
  const { x } = await rec(1000);
  clearInterval(t);
  check(peak(x) > 500, "microphone ring feeds the recording", peak(x));
}
a.audio.input.setSource("silence");
// drift: two recordings of 30 s each are exactly 30 s of frames in 30 s of wall time
a.audio.input.setSynth({ kind: "tone", hz: 440, levelDb: -20 }); a.audio.input.setSource("synth");
{
  const { r, wall } = await rec(30000);
  check(r.frames === 30 * RATE, "30 s recording holds exactly 1 440 000 frames", r.frames);
  check(Math.abs(wall - 30000) < 600, "no pacing drift over 30 s of wall time", wall);
}
done(a, "record");
