/**
 * 3D device view (three + @react-three/fiber). Lazy-loaded by DevicePane so the
 * 2D page never downloads three.js.
 *
 * Three models can be on show (src/device3d/customModel.ts decides which):
 *   - the maker's model bundled at /device/model.glb (the default when present),
 *   - the procedural "simple" model built in code (src/device3d/, always there),
 *   - a model the user loaded from his own computer.
 * All three share the studio light, the ground shadow, the live picture, the
 * invisible press targets, the pressed animations and the LED glow below.
 *
 * Rendering is on demand: a frame is drawn only when the view, the picture, a
 * control or the LED changes, and never while the tab or the canvas is hidden.
 *
 * Interaction (all drags use window listeners, so leaving the canvas is safe):
 *   glass pointerdown  -> touch input (point on the glass -> 410x502), no orbit
 *   button / d-pad     -> setButton, released on pointerup/cancel
 *   body / background  -> rotate the model (orbit); two pointers -> pinch zoom
 * The model's orientation IS the pose (pitch/roll/heading). When "tilt link"
 * is on it is mirrored to the bench's Movimento object, and the sliders move it.
 */
import { useFrame, useThree, Canvas, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useSyncExternalStore, Suspense } from 'react';
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  type PerspectiveCamera,
  PointLight,
  Plane,
  Raycaster,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import type { MotionPose } from '../device/motion';
import type { ButtonId, KodeDevice } from '../device/types';
import type { InputController } from '../lib/input';
import {
  BUTTON_PROUD_MM_ESTIMATE,
  BUTTON_TRAVEL_MM,
  DPAD_HIT_GROW_MM,
  DPAD_PROUD_MM_ESTIMATE,
  DPAD_TILT_RAD,
  bodyDims,
  buttonHitRadius,
  controlCentre,
  dpadHit,
  glassMmToScreen,
  screenToGlassMm,
} from '../lib/bodyModel';
import { SPEC, metrics } from '../lib/geometry';
import { ORBIT_LIMITS, ZERO_POSE, clampPose, poseToEuler, samePose } from '../lib/pose';
import type { ScreenPainter } from '../lib/screen';
import { buildBodyMesh } from '../device3d/bodyMesh';
import { customModel, type ActiveModel } from '../device3d/customModel';
import type { MeshData } from '../device3d/meshBuilder';
import { buildButton, buildDpadArm, buildGlass, buildLed, buildPad, buildScreen, buildScrew, buildWindow } from '../device3d/parts';
import { footprint } from '../device3d/stage';
import { makeStudioEnvironment } from '../device3d/studio';
import { makeGrainNormalMap, makeOcclusionTexture, makeShadowTexture } from '../device3d/textures';
import type { PreparedModel } from '../device3d/prepare';
import { backlightFactor } from './Device2D';

const M = metrics(SPEC);
const D = bodyDims(M);

// ---- look (see public/device/MODEL.md)
/** Matte warm off-white plastic. Chosen so that, under the studio light, the lit face lands near the render's #F0E8D9 without clipping. */
const CREAM = '#ebe6dc';
const BLACK_PLASTIC = '#313133';
const GLASS_BLACK = '#060607';
const LED_OFF = '#fbf6ae'; // pale yellow light guide when the LED is off
const EXPOSURE = 1.04;
/** The glass mirrors the studio only faintly: the picture must stay the picture. */
const GLASS_REFLECTION = 0.5;
/** The data's inlay colours are saturated base colours; the maker's render shows them lighter. A little self-colour gets there without washing them out. */
const INLAY_LIFT = 0.28;
/** The light guide is translucent: it never looks as dark as an opaque part, even when the LED is off. */
const LED_IDLE_GLOW = 0.22;
const ENV_INTENSITY = 1.0;
/** How strongly dark glossy parts of a loaded model mirror the (darker) studio. */
const FILE_GLOSS_REFLECTION = 0.6;

// ---- staging
const CAMERA_FOV = 30;
const CAMERA_ELEVATION = (8 * Math.PI) / 180; // slight look-down
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.4;
const DRAG_DEG_PER_PX = 0.45;
/** The ground (soft shadow only) sits this far below the upright device. */
const GROUND_GAP_MM = 9;
/**
 * The view the page opens with while the tilt link is off: a slight
 * three-quarter turn, so the depth, the fillets and the left wall read at
 * once. "Recentre" (and the tilt link) still mean exactly face-on.
 */
const OPENING_VIEW: MotionPose = { pitch: 0, roll: 17, heading: 0 };

export interface Device3DProps {
  device: KodeDevice;
  input: InputController;
  painter: ScreenPainter;
  /** Pose of the bench's active motion object, used when tiltLink is on. */
  storePose: MotionPose;
  tiltLink: boolean;
  onPose(p: MotionPose): void;
  resetSignal: number;
  reducedMotion: boolean;
  onContextLost(): void;
}

function toGeometry(m: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new BufferAttribute(m.uvs, 2));
  g.setAttribute('color', new BufferAttribute(m.colors, 3));
  g.setIndex(new BufferAttribute(m.indices, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const noRaycast = () => null;

function buildSimple() {
  const t0 = performance.now();
  const body = buildBodyMesh(D);
  const top = buildButton('top', D);
  const bottom = buildButton('bottom', D);
  const geo = {
    body: toGeometry(body),
    glass: toGeometry(buildGlass(D)),
    window: toGeometry(buildWindow(D)),
    pads: [0, 1, 2, 3, 4].map((i) => toGeometry(buildPad(i, D))),
    screw: toGeometry(buildScrew(D)),
    topBody: toGeometry(top.body),
    topInlay: toGeometry(top.inlay),
    bottomBody: toGeometry(bottom.body),
    bottomInlay: toGeometry(bottom.inlay),
    dpadArm: toGeometry(buildDpadArm(D)),
  };
  const all = [geo.body, geo.glass, geo.window, ...geo.pads, geo.screw, geo.topBody, geo.topInlay, geo.bottomBody, geo.bottomInlay, geo.dpadArm];
  // + the picture, the gloss over it and the light guide, which every model has
  const triangles = all.reduce((s, g) => s + (g.index?.count ?? 0) / 3, 0) + 3 * ((geo.dpadArm.index?.count ?? 0) / 3);
  return { ...geo, all, triangles, shellTriangles: body.indices.length / 3, buildMs: performance.now() - t0 };
}

// ------------------------------------------------------------------- canvas
export default function Device3D(props: Device3DProps) {
  return (
    <div className="device-surface relative min-h-0 min-w-0 flex-1" style={{ touchAction: 'none' }} data-testid="device-3d">
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, toneMapping: NeutralToneMapping, toneMappingExposure: EXPOSURE }}
        camera={{ fov: CAMERA_FOV, near: 20, far: 1500, position: [0, 0, 300] }}
        onCreated={({ gl }) => {
          gl.toneMapping = NeutralToneMapping;
          gl.toneMappingExposure = EXPOSURE;
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            props.onContextLost();
          });
          gl.domElement.setAttribute('data-testid', 'webgl-canvas');
        }}
      >
        <Suspense fallback={null}>
          <Scene {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
}

// -------------------------------------------------------------------- scene
function Scene({ device, input, painter, storePose, tiltLink, onPose, resetSignal, reducedMotion }: Device3DProps) {
  const { gl, camera, size, invalidate, scene } = useThree();

  // ---- which model
  const active = useSyncExternalStore(customModel.subscribe, customModel.getActive);
  useEffect(() => {
    void customModel.ensureBundled();
  }, []);
  // a context without WebGL 2 is taken as too weak for the detailed bundled model
  const shown: ActiveModel = active.kind === 'kode' && !gl.capabilities.isWebGL2 ? { kind: 'simple' } : active;
  const prepared: PreparedModel | null = shown.kind === 'kode' || shown.kind === 'custom' ? shown.model : null;
  const kind = shown.kind;

  // ---- geometry every model needs: the picture and the overlay light guide
  const common = useMemo(() => ({ screen: toGeometry(buildScreen(D)), led: toGeometry(buildLed(D)) }), []);
  // ---- the procedural model, built the first time it is shown
  const simpleCache = useRef<ReturnType<typeof buildSimple> | null>(null);
  const simple = useMemo(() => (kind === 'simple' ? (simpleCache.current ??= buildSimple()) : null), [kind]);
  useEffect(
    () => () => {
      simpleCache.current?.all.forEach((g) => g.dispose());
      common.screen.dispose();
      common.led.dispose();
    },
    [common],
  );

  // ---- materials
  const mats = useMemo(() => {
    const screenTex = new CanvasTexture(painter.canvas);
    screenTex.colorSpace = SRGBColorSpace;
    screenTex.minFilter = LinearFilter;
    screenTex.magFilter = LinearFilter;
    screenTex.generateMipmaps = false;
    const ao = makeOcclusionTexture(D);
    const grain = makeGrainNormalMap();
    const shadowTex = makeShadowTexture();
    const plastic = (color: string, roughness: number) => new MeshStandardMaterial({ color, roughness, metalness: 0, vertexColors: true, normalMap: grain, normalScale: new Vector2(0.07, 0.07) });
    return {
      screenTex,
      textures: [screenTex, ao, grain, shadowTex],
      body: new MeshStandardMaterial({ color: CREAM, map: ao, vertexColors: true, roughness: 0.74, metalness: 0, normalMap: grain, normalScale: new Vector2(0.11, 0.11) }),
      // the lit picture: unlit, straight sRGB, never tone-mapped
      screen: new MeshBasicMaterial({ map: screenTex, toneMapped: false }),
      // black glass under and around the picture, and the same glass's reflection added over the picture
      glass: new MeshStandardMaterial({ color: GLASS_BLACK, roughness: 0.1, metalness: 0, vertexColors: true, envMapIntensity: GLASS_REFLECTION }),
      gloss: new MeshStandardMaterial({ color: '#000000', roughness: 0.1, metalness: 0, transparent: true, blending: AdditiveBlending, depthWrite: false, envMapIntensity: GLASS_REFLECTION }),
      window: new MeshStandardMaterial({ color: '#111113', roughness: 0.36, metalness: 0, vertexColors: true, envMapIntensity: 0.1 }),
      dpad: plastic(BLACK_PLASTIC, 0.5),
      button: plastic(BLACK_PLASTIC, 0.44),
      inlayTop: new MeshStandardMaterial({ color: SPEC.top_px.colour, roughness: 0.4, emissive: SPEC.top_px.colour, emissiveIntensity: INLAY_LIFT }),
      inlayBot: new MeshStandardMaterial({ color: SPEC.bot_px.colour, roughness: 0.4, emissive: SPEC.bot_px.colour, emissiveIntensity: INLAY_LIFT }),
      gold: new MeshStandardMaterial({ color: '#f0b246', roughness: 0.34, metalness: 0.6, vertexColors: true }),
      silver: new MeshStandardMaterial({ color: '#e4e5e8', roughness: 0.32, metalness: 0.6, vertexColors: true }),
      led: new MeshStandardMaterial({ color: LED_OFF, roughness: 0.35, emissive: new Color(LED_OFF), emissiveIntensity: LED_IDLE_GLOW, vertexColors: true }),
      // the same two for meshes of a loaded file (no baked occlusion in their vertices)
      ledFile: new MeshStandardMaterial({ color: LED_OFF, roughness: 0.35, emissive: new Color(LED_OFF), emissiveIntensity: LED_IDLE_GLOW }),
      glassFile: new MeshStandardMaterial({ color: GLASS_BLACK, roughness: 0.1, metalness: 0, envMapIntensity: GLASS_REFLECTION }),
      hit: new MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: DoubleSide }), // invisible, still ray-cast
      shadow: new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.5 }),
    };
  }, [painter]);

  // ---- studio light (prefiltered environment; see device3d/studio.ts)
  const glossEnv = useRef<Texture | null>(null);
  useEffect(() => {
    const env = makeStudioEnvironment(gl);
    const gloss = makeStudioEnvironment(gl, true); // what the glass mirrors: the studio with a black flag in front
    glossEnv.current = gloss.texture;
    scene.environment = env.texture;
    scene.environmentIntensity = ENV_INTENSITY;
    const own = [mats.glass, mats.gloss, mats.window, mats.glassFile];
    for (const m of own) {
      m.envMap = gloss.texture;
      m.needsUpdate = true;
    }
    invalidate();
    return () => {
      scene.environment = null;
      glossEnv.current = null;
      for (const m of own) m.envMap = null;
      env.dispose();
      gloss.dispose();
    };
  }, [gl, scene, mats, invalidate]);

  // ---- a loaded model: its glass, light guide and glossy parts get the viewer's materials and reflections
  useEffect(() => {
    if (!prepared) return;
    for (const m of prepared.glass) m.material = mats.glassFile;
    for (const m of prepared.led) m.material = mats.ledFile;
    for (const m of prepared.glossy) {
      m.envMap = glossEnv.current;
      m.envMapIntensity = FILE_GLOSS_REFLECTION;
      m.needsUpdate = true;
    }
    restZ.current = new WeakMap();
    invalidate();
    return () => {
      for (const m of prepared.glossy) m.envMap = null;
    };
  }, [prepared, mats, invalidate]);

  useEffect(
    () => () => {
      mats.textures.forEach((t) => t.dispose());
      Object.values(mats).forEach((m) => (m as { dispose?: () => void }).dispose?.());
    },
    [mats],
  );

  // ---- refs
  const model = useRef<Group>(null);
  const glassMesh = useRef<Mesh | null>(null);
  const ledLight = useRef<PointLight>(null);
  const shadowMesh = useRef<Mesh>(null);
  const restZ = useRef(new WeakMap<Object3D, number>());
  const awake = useRef(true);
  const topGrp = useRef<Group>(null);
  const botGrp = useRef<Group>(null);
  const dpadTilt = useRef<Group>(null);
  const dpadRest = useRef<Group>(null);
  const opening = tiltLink ? ZERO_POSE : OPENING_VIEW;
  const target = useRef<MotionPose>({ ...opening });
  const display = useRef<MotionPose>({ ...opening });
  const zoom = useRef({ target: 1, display: 1 });
  const press = useRef<Record<ButtonId, number>>({ top: 0, bottom: 0, up: 0, down: 0, left: 0, right: 0 });
  const cancelInteraction = useRef<(() => void) | null>(null);
  const live = useRef({ tiltLink, onPose, reducedMotion, kind });
  live.current = { tiltLink, onPose, reducedMotion, kind };
  const dragging = useRef(false);

  // ---- subscriptions that wake the demand loop (nothing is drawn while the tab or the canvas is out of sight)
  useEffect(() => {
    const wake = () => {
      if (awake.current) invalidate();
    };
    const offs = [
      painter.onFrame(() => {
        if (!awake.current) return; // the texture is refreshed when the view comes back
        mats.screenTex.needsUpdate = true;
        invalidate();
      }),
      device.led.subscribe(wake),
      device.haptic.subscribe(wake),
      device.backlight.subscribe(wake),
      device.panelOn.subscribe(wake),
      input.pressed.subscribe(wake),
    ];
    let onScreen = true;
    const update = () => {
      const now = onScreen && document.visibilityState !== 'hidden';
      if (now && !awake.current) {
        awake.current = true;
        mats.screenTex.needsUpdate = true;
        invalidate();
      } else awake.current = now;
    };
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; update(); }) : null;
    io?.observe(gl.domElement);
    document.addEventListener('visibilitychange', update);
    mats.screenTex.needsUpdate = true;
    invalidate();
    return () => {
      offs.forEach((o) => o());
      io?.disconnect();
      document.removeEventListener('visibilitychange', update);
      awake.current = true;
    };
  }, [device, input, painter, mats, gl, invalidate]);

  // a different model: draw it
  useEffect(() => invalidate(), [kind, prepared, invalidate]);

  // ---- pose in: tilt link mirrors the store; otherwise the view is local
  useEffect(() => {
    if (tiltLink && !dragging.current) {
      target.current = { ...storePose };
      invalidate();
    }
  }, [tiltLink, storePose, invalidate]);

  useEffect(() => {
    if (!tiltLink) target.current = clampPose(target.current, ORBIT_LIMITS);
  }, [tiltLink]);

  // ---- recentre
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    target.current = { ...ZERO_POSE };
    zoom.current.target = 1;
    if (live.current.tiltLink) live.current.onPose({ ...ZERO_POSE });
    invalidate();
  }, [resetSignal, invalidate]);

  // ---- helpers
  const ray = useMemo(() => new Raycaster(), []);
  const tmp = useMemo(() => ({ v: new Vector3(), n: new Vector3(), p: new Plane(), ndc: new Vector2(), box: new Box3() }), []);


  /** Screen pixel under a client point: exact plane maths on the picture's own rectangle (keeps tracking off the glass), for every model. */
  const glassPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const mesh = glassMesh.current;
    if (!mesh) return null;
    const r = gl.domElement.getBoundingClientRect();
    tmp.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(tmp.ndc, camera);
    mesh.updateWorldMatrix(true, false);
    tmp.v.setFromMatrixPosition(mesh.matrixWorld);
    tmp.n.set(0, 0, 1).transformDirection(mesh.matrixWorld);
    tmp.p.setFromNormalAndCoplanarPoint(tmp.n, tmp.v);
    const hit = ray.ray.intersectPlane(tmp.p, new Vector3());
    if (!hit) return null;
    mesh.worldToLocal(hit);
    return glassMmToScreen(hit.x, hit.y, D);
  };

  const watch = (pointerId: number, onMove: ((e: PointerEvent) => void) | null, onEnd: (e: PointerEvent | null) => void) => {
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) onMove?.(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      onEnd(e);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      cancelInteraction.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    cancelInteraction.current = () => {
      stop();
      onEnd(null);
    };
  };

  // pinch zoom + wheel (DOM level on the canvas element)
  useEffect(() => {
    const el = gl.domElement;
    const pts = new Map<number, { x: number; y: number }>();
    let pinchStart: { d: number; z: number } | null = null;
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        cancelInteraction.current?.();
        pinchStart = { d: dist(), z: zoom.current.target };
      }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchStart && pts.size === 2) {
        zoom.current.target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (pinchStart.z * dist()) / pinchStart.d));
        invalidate();
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchStart = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom.current.target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.current.target * Math.exp(-e.deltaY * 0.0015)));
      invalidate();
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [gl, invalidate]);

  // ---- pointer handlers (R3F only does the first hit-test)
  const onGlassDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const ne = e.nativeEvent;
    if (!ne.isPrimary || (ne.pointerType === 'mouse' && ne.button !== 0)) return;
    const p = glassPoint(ne.clientX, ne.clientY);
    if (!p || !input.touchDown(ne.pointerId, p.x, p.y)) return;
    let last = p;
    watch(
      ne.pointerId,
      (ev) => {
        const q = glassPoint(ev.clientX, ev.clientY);
        if (q) {
          last = q;
          input.touchMove(ev.pointerId, q.x, q.y);
        }
      },
      () => input.touchUp(ne.pointerId, last.x, last.y),
    );
  };

  const holdButton = (id: ButtonId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const ne = e.nativeEvent;
    if (ne.pointerType === 'mouse' && ne.button !== 0) return;
    const src = `p3:${ne.pointerId}`;
    input.press(id, src);
    watch(ne.pointerId, null, () => input.release(id, src));
  };

  /** The generous invisible target over the pad: the point decides the arm. */
  const onDpadDown = (e: ThreeEvent<PointerEvent>) => {
    const rest = dpadRest.current;
    if (!rest) return;
    const local = rest.worldToLocal(e.point.clone());
    const dir = dpadHit(local.x, local.y, D);
    if (dir) holdButton(dir, e); // otherwise the event carries on to whatever is behind (button target or body)
  };

  const onBodyDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const ne = e.nativeEvent;
    if (ne.pointerType === 'mouse' && ne.button !== 0) return;
    const start = { x: ne.clientX, y: ne.clientY, pose: { ...(live.current.tiltLink ? storePose : target.current) } };
    dragging.current = true;
    watch(
      ne.pointerId,
      (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        const next: MotionPose = ev.shiftKey || ev.altKey
          ? { ...start.pose, heading: start.pose.heading + dx * DRAG_DEG_PER_PX }
          : { ...start.pose, roll: start.pose.roll + dx * DRAG_DEG_PER_PX, pitch: start.pose.pitch - dy * DRAG_DEG_PER_PX };
        const c = clampPose(next, ORBIT_LIMITS);
        target.current = c;
        if (live.current.tiltLink) live.current.onPose(c);
        invalidate();
      },
      () => {
        dragging.current = false;
      },
    );
  };

  const onBodyDouble = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    target.current = { ...ZERO_POSE };
    zoom.current.target = 1;
    if (live.current.tiltLink) live.current.onPose({ ...ZERO_POSE });
    invalidate();
  };

  // ---- debug hook (headless verification): only with ?debug in the URL
  const view = useRef<{ elevation: number; distance: number | null; fov: number; rotation: [number, number, number] | null; position: [number, number, number] | null; offsetY: number; shadow: boolean }>({ elevation: CAMERA_ELEVATION, distance: null, fov: CAMERA_FOV, rotation: null, position: null, offsetY: 0, shadow: true });
  const frameMs = useRef<number[]>([]);
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('debug')) return;
    const projectWorld = (v: Vector3) => {
      const r = gl.domElement.getBoundingClientRect();
      const p = v.clone().project(camera);
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    };
    const w = window as unknown as Record<string, unknown>;
    w.__dotbench3d = {
      /** Client coordinates of 'glass:x,y' (a screen pixel), 'top', 'bottom' or 'dpad:up|down|left|right'. */
      project(spec: string) {
        const g = model.current;
        if (!g) return null;
        g.updateWorldMatrix(true, true);
        camera.updateMatrixWorld();
        if (spec.startsWith('glass:')) {
          const [x, y] = spec.slice(6).split(',').map(Number);
          const mesh = glassMesh.current;
          if (!mesh) return null;
          const q = screenToGlassMm(x, y, D);
          return projectWorld(mesh.localToWorld(new Vector3(q.x, q.y, 0)));
        }
        const id = (spec.startsWith('dpad:') ? spec.slice(5) : spec) as ButtonId;
        if (!(id in press.current)) return null;
        return projectWorld(g.localToWorld(new Vector3(...hitCentre(id))));
      },
      scene: () => scene,
      textureVersion: () => mats.screenTex.version,
      rendered: () => gl.info.render.frame,
      pose: () => ({ ...display.current }),
      setPoseDebug: (p: MotionPose) => {
        target.current = p;
        invalidate();
      },
      /** Extras for scripts/model-shots.mjs. */
      setViewDebug: (v: { elevationDeg?: number; distance?: number | null; fovDeg?: number; zoom?: number; rotationZXY?: [number, number, number] | null; position?: [number, number, number] | null; offsetY?: number; shadow?: boolean }) => {
        if (v.shadow !== undefined) view.current.shadow = v.shadow; // ground shadow on/off (silhouette comparisons)
        if (v.position !== undefined) view.current.position = v.position; // model position override (mm)
        if (v.offsetY !== undefined) view.current.offsetY = v.offsetY; // look-at point, as a fraction of the body height below the centre
        if (v.rotationZXY !== undefined) view.current.rotation = v.rotationZXY; // radians about X, Y, Z, applied as Rz*Rx*Ry; null = follow the pose
        if (v.elevationDeg !== undefined) view.current.elevation = (v.elevationDeg * Math.PI) / 180;
        if (v.distance !== undefined) view.current.distance = v.distance;
        if (v.fovDeg !== undefined) view.current.fov = v.fovDeg;
        if (v.zoom !== undefined) zoom.current.target = zoom.current.display = v.zoom;
        invalidate();
      },
      /** Controls currently held, as the input layer sees them. */
      pressed: () => [...input.pressed.get()],
      info: () => ({
        model: kind,
        triangles: prepared ? prepared.stats.triangles + 2 * ((common.screen.index?.count ?? 0) / 3) : simple ? simple.triangles + 2 * ((common.screen.index?.count ?? 0) / 3) + (common.led.index?.count ?? 0) / 3 : 0,
        shellTriangles: simple?.shellTriangles ?? 0,
        buildMs: prepared ? prepared.stats.prepareMs : (simple?.buildMs ?? 0),
        stats: prepared?.stats ?? null,
        warnings: prepared?.warnings ?? [],
        calls: gl.info.render.calls,
        rendered: gl.info.render.triangles,
        webgl2: gl.capabilities.isWebGL2,
        dpr: gl.getPixelRatio(),
      }),
      /** Renders `n` frames back to back and returns the mean milliseconds per frame (GPU work included). */
      bench: (n = 60) => {
        const ctx = gl.getContext();
        const px = new Uint8Array(4);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          gl.render(scene, camera);
          ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px); // forces the frame to finish
        }
        return (performance.now() - t0) / n;
      },
      frameTimes: () => frameMs.current.slice(),
    };
    return () => {
      delete w.__dotbench3d;
    };
  }, [gl, camera, scene, simple, common, prepared, kind, mats, tmp, input, invalidate]);

  // ---- per-frame animation
  const baseDist = useRef(300);
  useFrame((_, dt) => {
    const rm = live.current.reducedMotion;
    let busy = false;
    if (frameMs.current.length < 600) frameMs.current.push(dt * 1000);

    // pose damping
    const k = rm ? 1 : 1 - Math.exp(-dt * 16);
    const d = display.current;
    const t = target.current;
    d.pitch += (t.pitch - d.pitch) * k;
    d.roll += (t.roll - d.roll) * k;
    d.heading += (t.heading - d.heading) * k;
    if (!samePose(d, t, 0.02)) busy = true;
    else Object.assign(d, t);
    const g = model.current;
    if (g) {
      const [ex, ey, ez] = poseToEuler(d);
      if (view.current.rotation) g.rotation.set(...view.current.rotation, 'ZXY');
      else g.rotation.set(ex, ey, ez, 'YXZ');
      // haptic: a small physical shake
      const h = rm ? 0 : device.haptic.get();
      if (h > 0.01) {
        g.position.set((Math.random() - 0.5) * h * 1.6, (Math.random() - 0.5) * h * 1.6, 0);
        busy = true;
      } else if (view.current.position) g.position.set(...view.current.position);
      else g.position.set(0, 0, 0);
      // ground shadow follows the footprint
      const sh = shadowMesh.current;
      if (sh) {
        sh.visible = view.current.shadow && live.current.kind !== 'pending';
        g.updateMatrix();
        const f = footprint(g.matrix.elements, D);
        const groundY = -(D.hh + GROUND_GAP_MM);
        const gap = Math.max(0, f.lowest - groundY);
        const soft = 1.9 + gap * 0.045; // the blob texture keeps half of its size as penumbra
        sh.position.set(f.x, groundY, f.z);
        sh.rotation.set(-Math.PI / 2, 0, -f.angle);
        sh.scale.set(f.a * 2 * soft, f.b * 2 * soft, 1);
        mats.shadow.opacity = 0.62 / (1 + gap * 0.035);
      }
    }

    // camera fit
    const cam = camera as PerspectiveCamera;
    if (cam.fov !== view.current.fov) {
      cam.fov = view.current.fov;
      cam.updateProjectionMatrix();
    }
    const aspect = size.width / Math.max(1, size.height);
    const halfH = Math.max((M.bodyMm.h / 2) * 1.16, ((M.bodyMm.w / 2) * 1.2) / aspect);
    baseDist.current = halfH / Math.tan((view.current.fov * Math.PI) / 360);
    const z = zoom.current;
    z.display += (z.target - z.display) * (rm ? 1 : 1 - Math.exp(-dt * 12));
    if (Math.abs(z.target - z.display) > 0.001) busy = true;
    else z.display = z.target;
    const dist = (view.current.distance ?? baseDist.current) / z.display;
    const lookY = -view.current.offsetY * M.bodyMm.h;
    camera.position.set(0, lookY + dist * Math.sin(view.current.elevation), dist * Math.cos(view.current.elevation));
    camera.lookAt(0, lookY, 0);

    // buttons
    const pr = input.pressed.get();
    const ease = rm ? 1 : 1 - Math.exp(-dt * 30);
    (Object.keys(press.current) as ButtonId[]).forEach((id) => {
      const goal = pr.has(id) ? 1 : 0;
      press.current[id] += (goal - press.current[id]) * ease;
      if (Math.abs(goal - press.current[id]) > 0.01) busy = true;
      else press.current[id] = goal;
    });
    const P = press.current;
    if (topGrp.current) topGrp.current.position.z = -P.top * BUTTON_TRAVEL_MM;
    if (botGrp.current) botGrp.current.position.z = -P.bottom * BUTTON_TRAVEL_MM;
    const lean = (tilt: Object3D, rest: number) => {
      // one rocker: it leans towards the held arm and sinks a little
      tilt.rotation.x = (P.up - P.down) * -DPAD_TILT_RAD;
      tilt.rotation.y = (P.right - P.left) * DPAD_TILT_RAD;
      tilt.position.z = rest - Math.max(P.up, P.down, P.left, P.right) * 0.25;
    };
    if (dpadTilt.current) lean(dpadTilt.current, 0);
    if (prepared) {
      const rest = (node: Object3D) => {
        let z = restZ.current.get(node);
        if (z === undefined) restZ.current.set(node, (z = node.position.z));
        return z;
      };
      for (const [id, node] of Object.entries(prepared.press) as [ButtonId, Object3D][]) node.position.z = rest(node) - P[id] * BUTTON_TRAVEL_MM;
      if (prepared.rocker) lean(prepared.rocker, rest(prepared.rocker));
    }

    // screen: backlight dim / panel off. Same dimming curve as the 2D view (an sRGB-space multiply).
    const bl = device.panelOn.get() ? backlightFactor(device.backlight.get()) : 0;
    mats.screen.color.setRGB(bl, bl, bl, SRGBColorSpace);

    // LED: light guide glows with the live colour
    const led = device.led.get();
    const on = led.r + led.g + led.b > 0;
    for (const lm of [mats.led, mats.ledFile]) {
      if (on) {
        // mostly self-lit, so the hue survives the tone mapping instead of burning out to white
        lm.color.setRGB(0.12 + (led.r / 255) * 0.4, 0.12 + (led.g / 255) * 0.4, 0.12 + (led.b / 255) * 0.4);
        lm.emissive.setRGB(led.r / 255, led.g / 255, led.b / 255);
        lm.emissiveIntensity = 1.0;
      } else {
        lm.color.set(LED_OFF);
        lm.emissive.set(LED_OFF);
        lm.emissiveIntensity = LED_IDLE_GLOW;
      }
    }
    if (ledLight.current) {
      ledLight.current.color.setRGB(led.r / 255, led.g / 255, led.b / 255);
      ledLight.current.intensity = on ? 520 : 0;
    }

    if (busy) invalidate();
  });

  // ---- a loaded model: a press on one of its control meshes holds that control, anything else turns the device
  const fileDown = (e: ThreeEvent<PointerEvent>) => {
    if (!prepared) return;
    for (let n: Object3D | null = e.object; n; n = n.parent) {
      if (n === prepared.rocker) {
        const local = n.worldToLocal(e.point.clone());
        const dir = dpadHit(local.x, local.y, D);
        return dir ? holdButton(dir, e) : e.stopPropagation();
      }
      for (const [id, node] of Object.entries(prepared.press) as [ButtonId, Object3D][]) if (n === node) return holdButton(id, e);
    }
    return onBodyDown(e);
  };

  // ---- where things are for the model on show
  const zf = D.zf;
  const rect = prepared ? prepared.screen : { cx: D.screen.cx, cy: D.screen.cy, w: D.screen.w, h: D.screen.h, z: zf };
  const screenScale: [number, number, number] = [rect.w / D.screen.w, rect.h / D.screen.h, 1];
  const hitCentre = (id: ButtonId): [number, number, number] => {
    if (!prepared) return controlCentre(id, D);
    if (id === 'top' || id === 'bottom') return [prepared.hit[id][0], prepared.hit[id][1], prepared.hit[id][2] - 0.1];
    const k = D.dpad.half * 0.68;
    const o = { up: [0, k], down: [0, -k], left: [-k, 0], right: [k, 0] }[id];
    return [prepared.hit.dpad[0] + o[0], prepared.hit.dpad[1] + o[1], prepared.hit.dpad[2]];
  };
  const hitTop: Record<'top' | 'bottom' | 'dpad', [number, number, number]> = prepared
    ? prepared.hit
    : { top: [D.buttons.top.x, D.buttons.top.y, zf + BUTTON_PROUD_MM_ESTIMATE], bottom: [D.buttons.bottom.x, D.buttons.bottom.y, zf + BUTTON_PROUD_MM_ESTIMATE], dpad: [D.dpad.x, D.dpad.y, zf + DPAD_PROUD_MM_ESTIMATE] };
  const frontZ = prepared ? prepared.analysis.frontZ : zf;
  const armNames = ['dpad_right', 'dpad_up', 'dpad_left', 'dpad_down'] as const;
  const armIds: ButtonId[] = ['right', 'up', 'left', 'down'];
  const dpadHitSize = (D.dpad.half + DPAD_HIT_GROW_MM) * 2;

  return (
    <>
      {/* soft shadow on the (implicit) ground */}
      <mesh ref={shadowMesh} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1} material={mats.shadow} raycast={noRaycast}>
        <planeGeometry args={[1, 1]} />
      </mesh>

      {/* background plane: drag to orbit */}
      <mesh position={[0, 0, -90]} material={mats.hit} onPointerDown={onBodyDown} onDoubleClick={onBodyDouble}>
        <planeGeometry args={[900, 900]} />
      </mesh>

      <group ref={model}>
        {/* the model itself */}
        {prepared && <primitive object={prepared.root} onPointerDown={fileDown} onDoubleClick={onBodyDouble} />}
        {simple && (
          <>
            <mesh name="body" geometry={simple.body} material={mats.body} onPointerDown={onBodyDown} onDoubleClick={onBodyDouble} />
            <mesh name="glass" geometry={simple.glass} material={mats.glass} onPointerDown={onBodyDown} />
            <mesh name="led" geometry={common.led} material={mats.led} onPointerDown={onBodyDown} />

            {/* right wall window; back: contact pads (first one silver) and the screw */}
            <mesh geometry={simple.window} material={mats.window} onPointerDown={onBodyDown} />
            {simple.pads.map((g, i) => (
              <mesh key={i} geometry={g} material={i === 0 ? mats.silver : mats.gold} onPointerDown={onBodyDown} />
            ))}
            <mesh geometry={simple.screw} material={mats.silver} onPointerDown={onBodyDown} />

            {/* round buttons: black body with a coloured inlay, moving as one */}
            {(['top', 'bottom'] as const).map((id) => {
              const b = D.buttons[id];
              return (
                <group key={id} position={[b.x, b.y, zf]}>
                  <group ref={id === 'top' ? topGrp : botGrp} name={id === 'top' ? 'btn_top' : 'btn_bottom'}>
                    <mesh geometry={id === 'top' ? simple.topBody : simple.bottomBody} material={mats.button} onPointerDown={(e) => holdButton(id, e)} />
                    <mesh geometry={id === 'top' ? simple.topInlay : simple.bottomInlay} material={id === 'top' ? mats.inlayTop : mats.inlayBot} onPointerDown={(e) => holdButton(id, e)} />
                  </group>
                </group>
              );
            })}

            {/* d-pad: four arm meshes on one rocker */}
            <group position={[D.dpad.x, D.dpad.y, zf]}>
              <group ref={dpadTilt}>
                {armIds.map((id, q) => (
                  <mesh key={id} name={armNames[q]} geometry={simple.dpadArm} material={mats.dpad} rotation={[0, 0, (q * Math.PI) / 2]} onPointerDown={(e) => holdButton(id, e)} />
                ))}
              </group>
            </group>
          </>
        )}

        {kind !== 'pending' && (
          <>
            {/* the live picture, and the glass's reflection over it */}
            <mesh name="screen" ref={glassMesh} geometry={common.screen} material={mats.screen} position={[rect.cx, rect.cy, rect.z + 0.012]} scale={screenScale} onPointerDown={onGlassDown} />
            <mesh geometry={common.screen} material={mats.gloss} position={[rect.cx, rect.cy, rect.z + 0.024]} scale={screenScale} raycast={noRaycast} renderOrder={2} />

            {/* light guide: the model's own part glows; a model without one gets this overlay */}
            {prepared && prepared.led.length === 0 && <mesh geometry={common.led} material={mats.led} position={[0, 0, frontZ - zf + 0.03]} onPointerDown={onBodyDown} />}
            <pointLight ref={ledLight} position={[D.led.bounds.x1 - 2, D.led.bounds.y1 - 2, frontZ + 5]} intensity={0} distance={60} decay={2} />

            {/* generous invisible press targets, just above the controls */}
            {(['top', 'bottom'] as const).map((id) => (
              <mesh key={id} position={[hitTop[id][0], hitTop[id][1], hitTop[id][2] + 0.15]} material={mats.hit} onPointerDown={(e) => holdButton(id, e)}>
                <circleGeometry args={[buttonHitRadius(id, D), 32]} />
              </mesh>
            ))}
            <group ref={dpadRest} position={[hitTop.dpad[0], hitTop.dpad[1], hitTop.dpad[2] + 0.15]}>
              <mesh material={mats.hit} onPointerDown={onDpadDown}>
                <planeGeometry args={[dpadHitSize, dpadHitSize]} />
              </mesh>
            </group>
          </>
        )}
      </group>
    </>
  );
}
