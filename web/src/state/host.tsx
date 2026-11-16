import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyPoseToBench, syncBench } from '../bench/sync';
import { BenchStore } from '../bench/store';
import { createDevice, type DeviceKind } from '../device';
import type { KodeDevice } from '../device/types';
import { UnsupportedRuntimeError, isRealDevice } from '../device/wasm';
import { useI18n, type TKey } from '../i18n';
import type { Vars } from '../i18n/core';
import { BundleStore, type BundleMeta } from '../lib/bundles';
import { builtinKey, fetchBuiltinBytes, isBuiltinKey, loadBuiltins, pickStartApp, type BuiltinApp } from '../lib/builtins';
import { InputController } from '../lib/input';
import { isEditableTarget, keyToButton, ownsArrowKeys } from '../lib/keys';
import { isPhone, useLayoutMode, type LayoutMode } from '../lib/layout';
import { customModel } from '../device3d/customModel';
import { ModelController, classifyFile, isModelStore, type CustomModelState, type CustomModelStore } from '../lib/modelChoice';
import type { MotionPose } from '../device/motion';
import { loadPref, safeLocal, savePref } from '../lib/prefs';
import { ScreenPainter } from '../lib/screen';
import { SensorBridge, vibrate } from '../lib/sensors';
import { useObservable } from './hooks';

export type ViewMode = '3d' | '2d';
export type Theme = 'dark' | 'light';
export interface Notice {
  id: number;
  kind: 'info' | 'error';
  key: TKey;
  vars?: Vars;
}

export interface Host {
  layout: LayoutMode;
  device: KodeDevice;
  useMock: boolean;
  setUseMock(v: boolean): void;
  input: InputController;
  painter: ScreenPainter;
  bench: BenchStore;

  bundles: BundleMeta[];
  builtins: BuiltinApp[];
  selectedId: string | null;
  addBundleFile(file: File): Promise<void>;
  runBundle(id: string): Promise<void>;
  removeBundle(id: string): Promise<void>;
  exportDevice(): Promise<void>;
  importDeviceFile(file: File): Promise<void>;
  restart(): Promise<void>;
  stop(): void;

  notice: Notice | null;
  dismissNotice(): void;
  /** True from page load until the first app start was attempted: "nothing runs yet" is then loading, not a stopped app. */
  launching: boolean;
  /** Bumped when some part of the page asks for the app list (idle card, welcome hint); the picker or the phone sheet opens it. */
  appsRequest: number;
  requestApps(): void;
  /** "Use my own 3D model": the controller over the 3D code's store (absent while that code has not landed). */
  model: ModelController;
  /** A dropped .glb waiting for the visitor's yes or no. */
  modelOffer: File | null;
  /** Any dropped or picked file: apps run, models are offered, the rest is declined politely. */
  openFile(file: File): void;
  applyModelFile(file: File): Promise<void>;
  resolveModelOffer(accept: boolean): void;
  /** First-visit hint, until the visitor dismisses it. */
  welcome: boolean;
  dismissWelcome(): void;

  theme: Theme;
  toggleTheme(): void;
  setTheme(t: Theme): void;
  viewMode: ViewMode;
  setViewMode(m: ViewMode): void;
  /** True when WebGL failed or was lost: the 3D view is unavailable this session. */
  glFailed: boolean;
  reportGlFailure(reason: 'unavailable' | 'lost'): void;
  tiltLink: boolean;
  setTiltLink(v: boolean): void;
  applyPose(p: MotionPose): void;

  wakeLock: boolean;
  setWakeLock(v: boolean): void;
  sensorsOn: boolean;
  toggleSensors(): Promise<void>;
  sensorError: TKey | null;
}

const Ctx = createContext<Host | null>(null);
export const useHost = (): Host => {
  const h = useContext(Ctx);
  if (!h) throw new Error('useHost outside HostProvider');
  return h;
};

let noticeSeq = 0;

/** Display name of a saved bundle: its file name without the extension. */
export const appLabel = (name: string): string => name.replace(/\.dotbench$/i, '');

export function HostProvider({ children }: { children: ReactNode }) {
  const { t, setLocale } = useI18n();
  const layout = useLayoutMode();
  const phone = isPhone(layout);

  const tRef = useRef(t);
  tRef.current = t;

  // long-lived services ------------------------------------------------------
  const services = useRef<{ bench: BenchStore; painter: ScreenPainter; bundles: BundleStore | null; model: ModelController } | null>(null);
  if (!services.current) {
    let bundles: BundleStore | null = null;
    try {
      bundles = typeof indexedDB === 'undefined' ? null : new BundleStore(indexedDB);
    } catch {
      bundles = null;
    }
    services.current = { bench: new BenchStore(safeLocal()), painter: new ScreenPainter(), bundles, model: new ModelController() };
  }
  const { bench, painter, bundles: bundleStore, model } = services.current;
  // the 3D code's own store; the controller tolerates anything that does not follow the contract
  useEffect(() => {
    if (!model.available && isModelStore(customModel)) model.setStore(customModel);
  }, [model]);

  const [useMock, setUseMockState] = useState(() => loadPref<boolean>('dotbench.mock', false) === true);
  const [device, setDevice] = useState<KodeDevice>(() => createDevice(loadPref<boolean>('dotbench.mock', false) === true ? 'mock' : 'wasm'));
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const selectedIdRef = useRef<string | null>(null);
  const input = useMemo(() => new InputController(() => deviceRef.current), []);

  // notices -----------------------------------------------------------------
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = useCallback((kind: Notice['kind'], key: TKey, vars?: Vars) => setNotice({ id: ++noticeSeq, kind, key, vars }), []);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const [appsRequest, setAppsRequest] = useState(0);
  const requestApps = useCallback(() => setAppsRequest((n) => n + 1), []);
  const [welcome, setWelcome] = useState(() => loadPref<boolean>('dotbench.welcomed', false) !== true);
  const dismissWelcome = useCallback(() => {
    setWelcome(false);
    savePref('dotbench.welcomed', true);
  }, []);

  // device lifecycle --------------------------------------------------------
  useEffect(() => {
    painter.attach(device);
    syncBench(device, bench);
    const off = bench.subscribe(() => syncBench(device, bench));
    if (device.info.kind === 'mock') void device.start();
    return () => {
      off();
    };
  }, [device, painter, bench]);

  const setUseMock = useCallback(
    (v: boolean) => {
      input.releaseAll();
      deviceRef.current.dispose();
      const kind: DeviceKind = v ? 'mock' : 'wasm';
      setUseMockState(v);
      savePref('dotbench.mock', v);
      setDevice(createDevice(kind));
      setLaunching(!v);
      setNotice(null);
    },
    [input],
  );

  // apps --------------------------------------------------------------------
  const [bundles, setBundles] = useState<BundleMeta[]>([]);
  const [bundlesLoaded, setBundlesLoaded] = useState(false);
  const [builtins, setBuiltins] = useState<BuiltinApp[]>([]);
  const [builtinsLoaded, setBuiltinsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadPref<string | null>('dotbench.bundle', null));
  const refresh = useCallback(async () => {
    if (!bundleStore) return;
    try {
      setBundles(await bundleStore.list());
    } catch (e) {
      say('error', 'notice.storageFail', { error: String((e as Error).message ?? e) });
    }
  }, [bundleStore, say]);
  useEffect(() => {
    void refresh().finally(() => setBundlesLoaded(true));
  }, [refresh]);
  useEffect(() => {
    void loadBuiltins().then((b) => {
      setBuiltins(b);
      setBuiltinsLoaded(true);
    });
  }, []);
  selectedIdRef.current = selectedId;
  const buildinsRef = useRef(builtins);
  buildinsRef.current = builtins;

  const [launching, setLaunching] = useState(() => loadPref<boolean>('dotbench.mock', false) !== true);
  const runBundleInner = useCallback(
    async (id: string): Promise<boolean> => {
      let name = id;
      try {
        let data: ArrayBuffer;
        if (isBuiltinKey(id)) {
          const app = buildinsRef.current.find((b) => builtinKey(b.id) === id);
          if (!app) return false;
          name = app.name;
          data = await fetchBuiltinBytes(app);
        } else {
          if (!bundleStore) {
            say('error', 'notice.storageFail', { error: 'IndexedDB' });
            return false;
          }
          const rec = await bundleStore.get(id);
          if (!rec) return false;
          name = rec.meta.name;
          data = rec.data;
        }
        const dev = deviceRef.current;
        await dev.load(data, { name });
        setSelectedId(id); // remembered only once it loaded
        savePref('dotbench.bundle', id);
        if (!dev.info.runsBundles) {
          say('info', 'notice.mockIgnores');
          return false;
        }
        await dev.start();
        setNotice(null);
        return true;
      } catch (e) {
        if (e instanceof UnsupportedRuntimeError) return false; // the stage card explains it
        if (deviceRef.current.status.get() === 'crashed') return false; // so does the crash card
        say('error', 'notice.loadFail', { name: appLabel(name), error: String((e as Error).message ?? e) });
        return false;
      }
    },
    [bundleStore, say],
  );
  const runBundle = useCallback(
    async (id: string) => {
      try {
        await runBundleInner(id);
      } finally {
        setLaunching(false);
      }
    },
    [runBundleInner],
  );

  // first visit (and every time the real device is switched on): start the remembered app, else the demo
  const autoFor = useRef<KodeDevice | null>(null);
  useEffect(() => {
    if (device.info.kind !== 'wasm' || !builtinsLoaded || !bundlesLoaded || autoFor.current === device) return;
    autoFor.current = device;
    if (isRealDevice(device) && device.unsupported.length) return setLaunching(false);
    const id = pickStartApp(selectedId, builtins, bundles.map((b) => b.id));
    if (id) void runBundle(id);
    else setLaunching(false);
  }, [device, builtinsLoaded, bundlesLoaded, builtins, bundles, selectedId, runBundle]);

  const addBundleFile = useCallback(
    async (file: File) => {
      if (!/\.dotbench$/i.test(file.name)) return say('error', 'notice.badExt');
      if (!bundleStore) return say('error', 'notice.storageFail', { error: 'IndexedDB' });
      try {
        const meta = await bundleStore.add(file.name, await file.arrayBuffer());
        await refresh();
        const ok = await runBundleInner(meta.id);
        setLaunching(false);
        // confirm where the file went: it runs now and stays under "Your apps"
        if (ok) say('info', 'notice.appAdded', { name: appLabel(meta.name) });
      } catch (e) {
        say('error', 'notice.storageFail', { error: String((e as Error).message ?? e) });
      }
    },
    [bundleStore, refresh, runBundleInner, say],
  );

  const removeBundle = useCallback(
    async (id: string) => {
      try {
        await bundleStore?.remove(id);
        if (selectedId === id) {
          setSelectedId(null);
          savePref('dotbench.bundle', null);
        }
        await refresh();
      } catch (e) {
        say('error', 'notice.storageFail', { error: String((e as Error).message ?? e) });
      }
    },
    [bundleStore, refresh, say, selectedId],
  );

  const restart = useCallback(async () => {
    try {
      await deviceRef.current.restart();
      setNotice(null);
    } catch (e) {
      if (deviceRef.current.info.kind === 'wasm') {
        // nothing loaded yet: start the remembered app, else the demo; with no app at all, say so instead of failing
        const id = selectedIdRef.current ?? pickStartApp(null, buildinsRef.current, []);
        if (id) return runBundle(id);
        return say('info', 'notice.nothingLoaded');
      }
      say('error', 'notice.loadFail', { name: '', error: String((e as Error).message ?? e) });
    }
  }, [say, runBundle]);
  const stop = useCallback(() => deviceRef.current.stop(), []);

  const exportDevice = useCallback(async () => {
    const dev = deviceRef.current;
    if (!isRealDevice(dev)) return say('info', 'notice.deviceMockOnly');
    try {
      const { data, extension } = await dev.exportDevice();
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `dotbench-device-${new Date().toISOString().slice(0, 10)}.${extension}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      say('info', 'notice.deviceExported');
    } catch (e) {
      say('error', 'notice.deviceFail', { error: String((e as Error).message ?? e) });
    }
  }, [say]);
  const importDeviceFile = useCallback(
    async (file: File) => {
      const dev = deviceRef.current;
      if (!isRealDevice(dev)) return say('info', 'notice.deviceMockOnly');
      try {
        await dev.importDevice(new Uint8Array(await file.arrayBuffer()));
        say('info', 'notice.deviceImported');
      } catch (e) {
        say('error', 'notice.deviceFail', { error: String((e as Error).message ?? e) });
      }
    },
    [say],
  );

  // theme / view ------------------------------------------------------------
  const [theme, setTheme] = useState<Theme>(() => (loadPref<string>('dotbench.theme', 'light') === 'dark' ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === 'dark' ? 'light' : 'dark';
      savePref('dotbench.theme', next);
      return next;
    });
  }, []);

  const chooseTheme = useCallback((next: Theme) => {
    setTheme(next);
    savePref('dotbench.theme', next);
  }, []);

  const viewKey = phone ? 'dotbench.view.phone' : 'dotbench.view';
  const [viewPrefs, setViewPrefs] = useState<Record<string, ViewMode>>(() => ({
    'dotbench.view': loadPref<ViewMode>('dotbench.view', '3d') === '2d' ? '2d' : '3d',
    'dotbench.view.phone': loadPref<ViewMode>('dotbench.view.phone', '2d') === '3d' ? '3d' : '2d',
  }));
  const setViewMode = useCallback(
    (m: ViewMode) => {
      setViewPrefs((p) => ({ ...p, [viewKey]: m }));
      savePref(viewKey, m);
    },
    [viewKey],
  );
  const [glFailed, setGlFailed] = useState(false);
  const reportGlFailure = useCallback(
    (reason: 'unavailable' | 'lost') => {
      setGlFailed(true);
      say('info', reason === 'lost' ? 'device.glLost' : 'device.glFallback');
    },
    [say],
  );
  const [tiltLink, setTiltLink] = useState(false);
  const applyPose = useCallback((p: MotionPose) => applyPoseToBench(bench, p, () => tRef.current('kind.motion.pose')), [bench]);

  // own 3D model -----------------------------------------------------------
  const [modelOffer, setModelOffer] = useState<File | null>(null);
  const applyModelFile = useCallback(
    async (file: File) => {
      const r = await model.use(file, file.name);
      if (r.ok) {
        if (!glFailed) setViewMode('3d'); // show what was just loaded
        return say('info', 'notice.modelUsed', { name: file.name });
      }
      if (r.reason === 'unavailable') return say('info', 'notice.modelUnavailable');
      if (r.reason === 'not-glb') return say('error', 'notice.notGlb');
      say('error', 'notice.modelFail', { name: file.name, error: r.message || '?' });
    },
    [model, glFailed, setViewMode, say],
  );
  const openFile = useCallback(
    (file: File) => {
      const kind = classifyFile(file.name);
      if (kind === 'app') return void addBundleFile(file);
      if (kind === 'other') return say('error', 'notice.dropOther', { name: file.name });
      if (!model.available) return say('info', 'notice.modelUnavailable');
      setModelOffer(file); // a model replaces what the 3D view shows: ask first
    },
    [addBundleFile, model, say],
  );
  const resolveModelOffer = useCallback(
    (accept: boolean) => {
      setModelOffer((file) => {
        if (accept && file) void applyModelFile(file);
        return null;
      });
    },
    [applyModelFile],
  );

  // debug hook for the headless checks (?debug in the URL)
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('debug')) return;
    (window as unknown as Record<string, unknown>).__dotbench = {
      device: () => deviceRef.current,
      bench,
      input,
      painter,
      model,
      // lets the layout audit walk every theme and language on one page load
      ui: {
        // stands in for the 3D code's store, so every state of the "3D model" entry can be shown and audited
        fakeModel: (state: CustomModelState | null) => {
          if (!state) return model.setStore(null);
          const listeners = new Set<() => void>();
          let cur = state;
          const store: CustomModelStore = {
            getState: () => cur,
            subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
            load: async (_f, name) => {
              cur = { ...cur, status: 'ready', name, sizeBytes: _f.size, warnings: [], error: undefined };
              for (const l of listeners) l();
            },
            remove: async () => {
              cur = { status: 'none', builtin: cur.builtin, bundled: cur.bundled, performance: cur.performance, options: cur.options, selected: cur.options?.[0]?.id };
              for (const l of listeners) l();
            },
            setBuiltin: (choice) => {
              cur = { ...cur, builtin: choice };
              for (const l of listeners) l();
            },
            setOptions: async (o) => {
              cur = { ...cur, performance: o.performance ?? cur.performance };
              for (const l of listeners) l();
            },
            ...(state.options ? { select: async (id: string) => ((cur = { ...cur, selected: id }), listeners.forEach((l) => l())) } : {}),
          };
          model.setStore(store);
        },
        offerModel: (name: string) => setModelOffer(new File([new Uint8Array(1024)], name)),
        setTheme: (v: Theme) => setTheme(v),
        setLocale,
        notify: (kind: Notice['kind'], key: TKey, vars?: Vars) => say(kind, key, vars),
      },
    };
  }, [bench, input, painter, setLocale, say, model]);

  // input: keyboard, visibility ---------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const id = keyToButton(e);
      if (!id) return;
      if (e.key.startsWith('Arrow') && ownsArrowKeys(e.target)) return; // tabs, menus, sliders and scroll regions keep their arrows
      e.preventDefault();
      input.press(id, `key:${e.key.toLowerCase()}`);
    };
    const up = (e: KeyboardEvent) => {
      const id = keyToButton(e);
      if (id) input.release(id, `key:${e.key.toLowerCase()}`);
    };
    const releaseAll = () => input.releaseAll();
    const vis = () => {
      if (document.visibilityState === 'hidden') input.releaseAll();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pagehide', releaseAll);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [input]);

  // phone vibration ---------------------------------------------------------
  const haptic = useObservable(device.haptic);
  const hapticPrev = useRef(0);
  useEffect(() => {
    if (haptic >= 0.05 && hapticPrev.current < 0.05) vibrate(Math.round(20 + haptic * 180));
    else if (haptic === 0 && hapticPrev.current > 0) vibrate(0);
    hapticPrev.current = haptic;
  }, [haptic]);

  // wake lock ----------------------------------------------------------------
  const [wakeLock, setWakeLockState] = useState<boolean>(() => loadPref('dotbench.wake', true));
  const setWakeLock = useCallback((v: boolean) => {
    setWakeLockState(v);
    savePref('dotbench.wake', v);
  }, []);
  const status = useObservable(device.status);
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (!wakeLock || status !== 'running' || !nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let live = true;
    const acquire = async () => {
      try {
        const l = await nav.wakeLock!.request('screen');
        if (live) lock = l;
        else void l.release().catch(() => {});
      } catch {
        /* not allowed right now: ignore */
      }
    };
    void acquire();
    const vis = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', vis);
      void lock?.release().catch(() => {});
    };
  }, [wakeLock, status]);

  // phone sensors -----------------------------------------------------------
  const [sensorsOn, setSensorsOn] = useState(false);
  const [sensorError, setSensorError] = useState<TKey | null>(null);
  const bridge = useRef<SensorBridge | null>(null);
  const toggleSensors = useCallback(async () => {
    if (bridge.current) {
      bridge.current.stop();
      bridge.current = null;
      setSensorsOn(false);
      return;
    }
    setSensorError(null);
    const b = new SensorBridge(
      (p) => applyPoseToBench(bench, p, () => tRef.current('kind.motion.pose')),
      () => deviceRef.current.areas.motion?.shake?.(),
      () => {
        setSensorError('sensors.noData');
        b.stop();
        bridge.current = null;
        setSensorsOn(false);
      },
    );
    const r = await b.start();
    if (!r.ok) return setSensorError(r.reason);
    bridge.current = b;
    setSensorsOn(true);
  }, [bench]);
  useEffect(() => () => bridge.current?.stop(), []);

  const host: Host = {
    layout,
    device,
    useMock,
    setUseMock,
    input,
    painter,
    bench,
    bundles,
    builtins,
    selectedId,
    addBundleFile,
    runBundle,
    removeBundle,
    exportDevice,
    importDeviceFile,
    restart,
    stop,
    notice,
    dismissNotice,
    launching: launching && device.info.kind === 'wasm',
    appsRequest,
    requestApps,
    model,
    modelOffer,
    openFile,
    applyModelFile,
    resolveModelOffer,
    welcome,
    dismissWelcome,
    theme,
    toggleTheme,
    setTheme: chooseTheme,
    viewMode: glFailed ? '2d' : viewPrefs[viewKey],
    setViewMode,
    glFailed,
    reportGlFailure,
    tiltLink,
    setTiltLink,
    applyPose,
    wakeLock,
    setWakeLock,
    sensorsOn,
    toggleSensors,
    sensorError,
  };
  return <Ctx.Provider value={host}>{children}</Ctx.Provider>;
}
