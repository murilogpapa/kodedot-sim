/**
 * Model stand: the 3D device alone on the page colour, with a stand-in device.
 * Used by scripts/model-shots.mjs (and handy for looking at the model without
 * the rest of the page). Not part of the application bundle.
 *
 * URL parameters: ?debug (always wanted), led=RRGGBB, backlight=0..100,
 * panel=off, still (no clock tick), model=simple|kode.
 */
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Atom, LogBuffer } from '../../device/observable';
import type { ButtonId, Frame, KodeDevice, Rgb } from '../../device/types';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../device/types';
import { InputController } from '../../lib/input';
import { ZERO_POSE } from '../../lib/pose';
import { ScreenPainter } from '../../lib/screen';

import { customModel } from '../customModel';

const Device3D = lazy(() => import('../../components/Device3D'));
const q = new URLSearchParams(location.search);

// ---- a plain test picture (drawn here; nothing is copied from the references)
const art = document.createElement('canvas');
art.width = SCREEN_WIDTH;
art.height = SCREEN_HEIGHT;
const g = art.getContext('2d')!;
let seq = 0;
let frame: Frame = { seq: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT, data: new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4) };
function paint(tick: number) {
  g.fillStyle = '#0b0b0d';
  g.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  g.fillStyle = '#8d8d92';
  g.font = '600 15px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('TEST', 150, 62);
  g.strokeStyle = '#8d8d92';
  g.lineWidth = 2;
  g.strokeRect(196, 48, 26, 16);
  g.strokeRect(244, 48, 26, 16);
  g.fillStyle = '#fff';
  g.font = '700 86px system-ui, sans-serif';
  g.fillText(q.has('still') ? '12:34' : `12:${String(34 + (tick % 20)).padStart(2, '0')}`, SCREEN_WIDTH / 2, 190);
  // a large round blue shape and a card, to judge colour and crispness
  g.fillStyle = '#e7a23a'; // not blue or red: the shot checks look for the button inlays by colour
  g.beginPath();
  g.arc(265, 420, 150, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#101012';
  g.fillRect(60, 330, 190, 110);
  g.fillStyle = '#fff';
  g.font = '500 24px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText('Model stand', 76, 372);
  g.fillText('410 x 502', 76, 406);
  // one-pixel checker in the corners (sharpness) and primaries (colour)
  for (const [ox, oy] of [[0, 0], [SCREEN_WIDTH - 16, 0], [0, SCREEN_HEIGHT - 16], [SCREEN_WIDTH - 16, SCREEN_HEIGHT - 16]])
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      g.fillStyle = (x + y) % 2 ? '#fff' : '#000';
      g.fillRect(ox + x, oy + y, 1, 1);
    }
  ['#00d060', '#f4e04d', '#ffffff', '#808080', '#404040'].forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect(150 + i * 24, 250, 20, 20);
  });
  const img = g.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  frame = { seq: ++seq, width: SCREEN_WIDTH, height: SCREEN_HEIGHT, data: img.data };
}
paint(0);
if (!q.has('still')) setInterval(() => paint(Math.floor(performance.now() / 500)), 500);

// ---- stand-in device: only what the 3D view and the input layer use
const hex = q.get('led');
const led = new Atom<Rgb>(hex ? { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) } : { r: 0, g: 0, b: 0 });
const log = new LogBuffer();
const events: string[] = [];
const cycle: Rgb[] = [{ r: 255, g: 60, b: 40 }, { r: 40, g: 255, b: 90 }, { r: 60, g: 120, b: 255 }, { r: 0, g: 0, b: 0 }];
let ledAt = -1;
const device = {
  info: { name: 'model stand' },
  getFrame: () => frame,
  backlight: new Atom(Number(q.get('backlight') ?? 100)),
  panelOn: new Atom(q.get('panel') !== 'off'),
  led,
  haptic: new Atom(0),
  log,
  setButton(id: ButtonId, pressed: boolean) {
    events.push(`button ${id} ${pressed ? 'pressed' : 'released'}`);
    if (id === 'top' && pressed) led.set(cycle[(ledAt = (ledAt + 1) % cycle.length)]);
  },
  setTouch(x: number, y: number, down: boolean) {
    events.push(`touch ${x},${y} ${down ? 'down' : 'up'}`);
  },
} as unknown as KodeDevice;
const input = new InputController(() => device);
const painter = new ScreenPainter();
painter.attach(device);
// ?model=simple|kode picks the built-in model for this visit (the stand's own storage is fresh in the scripts)
const pick = q.get('model');
if (pick === 'simple' || pick === 'kode') customModel.setBuiltin(pick);
(window as unknown as Record<string, unknown>).__stand = {
  events,
  led: () => led.get(),
  device,
  model: customModel,
  /** Load a model file through the same store the page's menu uses. */
  loadModel: async (base64: string, name: string) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await customModel.load(new Blob([bytes]), name);
    return customModel.getState();
  },
  /** The same file as it comes: one mesh per primitive, its own materials (for "before" measurements). */
  loadModelRaw: async (base64: string, name: string) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const { prepareModel } = await import('../prepare');
    customModel.debugShow(await prepareModel(bytes.buffer, { raw: true, maxTexture: 8192 }), name);
    return customModel.getState();
  },
};

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Device3D device={device} input={input} painter={painter} storePose={ZERO_POSE} tiltLink={false} onPose={() => {}} resetSignal={0} reducedMotion={reduced} onContextLost={() => events.push('context lost')} />
    </Suspense>
  </StrictMode>,
);
