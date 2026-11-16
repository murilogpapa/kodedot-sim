import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { poseOf, MOTION_KIND } from '../bench/motion';
import { useBenchState } from '../state/bench';
import { useI18n } from '../i18n';
import { isPhone } from '../lib/layout';
import { ZERO_POSE } from '../lib/pose';
import { loadPref, savePref } from '../lib/prefs';
import { useHost } from '../state/host';
import type { PanelId, PanelPlacement } from '../lib/layout';
import { Device2D } from './Device2D';
import { DeviceStatusCard } from './DeviceStatusCard';
import { Icon } from './Glyphs';
import { ModelOffer } from './ModelControls';
import { NoticeBanner } from './Notice';

const Device3D = lazy(() => import('./Device3D'));

let glProbe: boolean | null = null;
export function webglAvailable(): boolean {
  if (glProbe !== null) return glProbe;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    glProbe = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    glProbe = false;
  }
  return glProbe;
}

export function useReducedMotion(): boolean {
  const [rm, setRm] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setRm(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return rm;
}

class Boundary extends Component<{ onError(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The 3D canvas releases its WebGL context when it unmounts (switching to 2D). That is not a failure, so "context lost"
 * only counts while this wrapper is mounted.
 */
function Live3D(props: ComponentProps<typeof Device3D>) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Device3D
      {...props}
      onContextLost={() => {
        if (alive.current) props.onContextLost();
      }}
    />
  );
}

type Zoom2D = 'fit' | 1 | 2 | 3;
const ZOOMS: readonly Zoom2D[] = ['fit', 1, 2, 3];

export interface PanelControl {
  open: boolean;
  placement: PanelPlacement;
  toggle(): void;
}

/** Opens or closes a side card. It sits at the end of the stage toolbar on the card's own side. */
function PanelToggle({ id, ctl }: { id: PanelId; ctl: PanelControl }) {
  const { t } = useI18n();
  const label = t(id === 'bench' ? 'nav.bench' : 'nav.console');
  const hint = t(ctl.open ? 'panel.hide' : 'panel.show', { panel: label });
  return (
    <button type="button" className="chip" aria-expanded={ctl.open} aria-controls={`panel-${id}`} aria-label={hint} title={hint} onClick={ctl.toggle} data-testid={`drawer-${id}`}>
      <Icon name={id === 'bench' ? 'panelLeft' : 'panelRight'} className={id === 'console' ? 'order-2' : ''} />
      <span className={ctl.open ? 'hidden @[680px]:inline' : ''}>{label}</span>
    </button>
  );
}

export function DevicePane({ panels }: { panels?: Record<PanelId, PanelControl> }) {
  const { t } = useI18n();
  const host = useHost();
  const { layout, viewMode, device, painter } = host;
  const phone = isPhone(layout);
  const reduced = useReducedMotion();
  const [zoom2d, setZoom2d] = useState<Zoom2D>(() => {
    const z = loadPref<unknown>('dotbench.zoom2d', 'fit');
    return z === 1 || z === 2 || z === 3 ? z : 'fit';
  });
  const [resetSignal, setResetSignal] = useState(0);

  // WebGL unavailable => 2D for this session
  useEffect(() => {
    if (viewMode === '3d' && !host.glFailed && !webglAvailable()) host.reportGlFailure('unavailable');
  }, [viewMode, host]);

  const benchState = useBenchState(host.bench);
  const active = benchState.slots.motion ? benchState.objects.find((o) => o.id === benchState.slots.motion && o.kind === MOTION_KIND) : undefined;
  const storePose = active ? poseOf(active) : ZERO_POSE;

  const pickZoom = (z: Zoom2D) => {
    setZoom2d(z);
    savePref('dotbench.zoom2d', z);
  };

  const showToolbar = !phone || viewMode === '3d';
  const show3d = viewMode === '3d' && !host.glFailed;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('device.region')}>
      {showToolbar && (
        <div className={`@container flex shrink-0 items-center gap-2 ${phone ? 'justify-center px-2 py-2' : 'relative z-[35] h-[60px] px-2'}`} role="toolbar" aria-label={t('device.view')} style={phone ? { paddingTop: 'max(8px, env(safe-area-inset-top))' } : undefined}>
          {panels && <PanelToggle id="bench" ctl={panels.bench} />}
          <div className={`flex min-w-0 items-center justify-center gap-2 ${phone ? '' : 'flex-1'}`}>
            <div className="seg" role="group" aria-label={t('device.view')}>
              <button type="button" className="chip" aria-pressed={show3d} disabled={host.glFailed} title={host.glFailed ? t('device.glFallback') : undefined} onClick={() => host.setViewMode('3d')} data-testid="view-3d">
                3D
              </button>
              <button type="button" className="chip" aria-pressed={!show3d} onClick={() => host.setViewMode('2d')} data-testid="view-2d">
                2D
              </button>
            </div>
            {show3d ? (
              <>
                <button type="button" className="chip" onClick={() => setResetSignal((n) => n + 1)} data-testid="recenter" aria-label={t('device.recenter')} title={t('device.recenter')}>
                  <Icon name="recenter" />
                  <span className="hidden @[600px]:inline">{t('device.recenter')}</span>
                </button>
                <label className="pill h-[var(--compact-h)] cursor-pointer !gap-2 !pl-1.5" title={t('device.tilt.hint')}>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={host.tiltLink}
                    data-testid="tilt-link"
                    aria-label={t('device.tilt.hint')}
                    onChange={(e) => {
                      host.setTiltLink(e.target.checked);
                      if (e.target.checked && !host.bench.activeIn('motion')) host.applyPose(ZERO_POSE);
                    }}
                  />
                  <span className="font-semibold">{t('device.tilt')}</span>
                </label>
              </>
            ) : (
              !phone && (
                <div className="seg" role="group" aria-label={t('device.zoom')} data-testid="zoom-group">
                  {ZOOMS.map((z) => (
                    <button key={z} type="button" aria-pressed={zoom2d === z} className="chip" title={z === 'fit' ? t('device.fit.hint') : t('device.zoom.hint', { zoom: z })} onClick={() => pickZoom(z)} data-testid={`zoom-${z}`}>
                      {z === 'fit' ? t('device.fit') : `${z}×`}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
          {panels && <PanelToggle id="console" ctl={panels.console} />}
        </div>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="stage" style={phone ? { padding: `${showToolbar ? '0px' : 'env(safe-area-inset-top)'} env(safe-area-inset-right) 0 env(safe-area-inset-left)` } : undefined}>
        {show3d ? (
          <Boundary onError={() => host.reportGlFailure('unavailable')}>
            <Suspense fallback={<div className="m-auto text-[14px] text-ink2">{t('device.loading3d')}</div>}>
              <Live3D
                device={device}
                input={host.input}
                painter={painter}
                storePose={storePose}
                tiltLink={host.tiltLink}
                onPose={host.applyPose}
                resetSignal={resetSignal}
                reducedMotion={reduced}
                onContextLost={() => host.reportGlFailure('lost')}
              />
            </Suspense>
          </Boundary>
        ) : (
          <Device2D zoom={phone ? 'fit' : zoom2d} crop={phone} inset={phone ? 0 : 8} />
        )}
        <DeviceStatusCard />
        <ModelOffer />
        <NoticeBanner />
      </div>
      {!phone && <WelcomeHint />}
    </section>
  );
}

/**
 * First visit only: says that the device is live, how to run an app of one's own and where the bench is. It never
 * covers the device: under it on desktop, on top of the bottom bar on a phone, inside the side panel in phone landscape.
 * Gone for good with "Got it", or once an own app was loaded.
 */
export function WelcomeHint({ variant = 'desk' }: { variant?: 'desk' | 'bar' | 'panel' }) {
  const { t } = useI18n();
  const { welcome, dismissWelcome, requestApps, bundles } = useHost();
  useEffect(() => {
    if (welcome && bundles.length > 0) dismissWelcome();
  }, [welcome, bundles.length, dismissWelcome]);
  if (!welcome) return null;
  if (variant !== 'desk') {
    return (
      <aside className={`anim-rise shrink-0 ${variant === 'panel' ? 'px-3 pb-2' : 'px-3'}`} aria-label={t('welcome.title')} data-testid="welcome">
        <div className="inner flex items-center gap-2 py-1.5 pl-4 pr-1.5">
          <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-snug">
            <strong className="font-semibold">{t('welcome.title')}</strong> {t(variant === 'panel' ? 'welcome.body.side' : 'welcome.body.phone')}
          </p>
          <button type="button" className="btn btn-sm btn-primary shrink-0" onClick={dismissWelcome} data-testid="welcome-dismiss">
            {t('welcome.dismiss')}
          </button>
        </div>
      </aside>
    );
  }
  return (
    <aside className="anim-rise shrink-0 pb-1 pt-2" aria-label={t('welcome.title')} data-testid="welcome">
      <div className="inner mx-auto flex max-w-[44rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <p className="m-0 min-w-[14rem] flex-1 text-[14px] leading-snug">
          <strong className="font-semibold">{t('welcome.title')}</strong> {t('welcome.body')}
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="btn btn-sm" onClick={requestApps} data-testid="welcome-open">
            {t('welcome.open')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={dismissWelcome} data-testid="welcome-dismiss">
            {t('welcome.dismiss')}
          </button>
        </div>
      </div>
    </aside>
  );
}
