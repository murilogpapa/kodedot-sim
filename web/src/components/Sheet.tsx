import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useI18n } from '../i18n';
import { useLayer } from '../lib/layers';
import { detentHeights, snapDetent, type Detent } from '../lib/sheet';
import { useHost } from '../state/host';
import { AppsList } from './AppsList';
import { DeviceActions } from './DeviceMenu';
import { WelcomeHint } from './DevicePane';
import { ConsolePanel } from './ConsolePanel';
import { LanguageSelect, MockToggle, RunButtons, ThemeChoice } from './Controls';
import { Icon } from './Glyphs';
import { LeftPanel } from './LeftPanel';
import { ModelControls } from './ModelControls';
import { About } from './TopBar';
import { ScrollArea, useTabs } from './ui';

type Tab = 'bench' | 'console' | 'apps' | 'settings';
const TABS: readonly Tab[] = ['bench', 'console', 'apps', 'settings'];

/** How much of the handle's 44 px target reaches above the sheet's top edge. */
const HANDLE_ABOVE = 24;

/**
 * Phone UI. Portrait: a bottom sheet with three detents; its tab row stays visible as a bar under the device, so the
 * bench, the console, the apps and the settings are always one tap away. Landscape: the same panel docked beside the
 * device (there is room for both), with a handle on the edge when it is closed.
 * Reports the space it takes so the device can stay fully visible next to it.
 */
export function Sheet({ landscape, onInset }: { landscape: boolean; onInset(px: number, animate: boolean): void }) {
  const { t } = useI18n();
  const { appsRequest, welcome, dismissWelcome } = useHost();
  const [tab, setTab] = useState<Tab>('bench');
  const [detent, setDetent] = useState<Detent>('peek');
  const [sideOpen, setSideOpen] = useState(true);
  const [vh, setVh] = useState(() => window.innerHeight);
  const [drag, setDrag] = useState<number | null>(null); // live height while the handle is dragged
  const ref = useRef<HTMLElement>(null);
  const open = landscape ? sideOpen : detent !== 'peek';

  useEffect(() => {
    const on = () => setVh(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const heights = detentHeights(vh);
  const height = drag ?? heights[detent];
  const close = () => (landscape ? setSideOpen(false) : setDetent('peek'));
  const show = (to: Tab) => {
    setTab(to);
    if (landscape) setSideOpen(true);
    else setDetent((d) => (d === 'peek' ? 'half' : d));
  };
  const tabs = useTabs(TABS, tab, show);

  // Escape closes it and focus returns to the handle or the tab that opened it; presses on the device do not close it
  useLayer(open && !landscape, close, ref, { autoFocus: false, dismissOutside: false });

  // another part of the page asked for the app list
  const seen = useRef(appsRequest);
  useEffect(() => {
    if (appsRequest === seen.current) return;
    seen.current = appsRequest;
    setTab('apps');
    if (landscape) setSideOpen(true);
    else setDetent((d) => (d === 'peek' ? 'half' : d));
  }, [appsRequest, landscape]);

  // first-visit hint: it rides on top of the closed bar and leaves once the panel was opened
  const hintRef = useRef<HTMLDivElement>(null);
  const [hintH, setHintH] = useState(0);
  const showHint = welcome && !landscape && detent === 'peek' && drag === null;
  useEffect(() => {
    if (welcome && !landscape && detent !== 'peek') dismissWelcome();
  }, [welcome, landscape, detent, dismissWelcome]);
  useEffect(() => {
    const el = hintRef.current;
    if (!showHint || !el) return setHintH(0);
    const ro = new ResizeObserver(() => setHintH(el.offsetHeight));
    ro.observe(el);
    setHintH(el.offsetHeight);
    return () => ro.disconnect();
  }, [showHint]);

  // the device keeps clear of the bar and of the half-open sheet; a full sheet covers it instead of squeezing it
  useEffect(() => {
    if (landscape) return onInset(0, false);
    onInset(Math.min(height, heights.half) + HANDLE_ABOVE + (showHint ? hintH + 4 : 0), drag === null);
  }, [landscape, height, heights.half, drag, onInset, showHint, hintH]);

  // ---- handle: tap steps through the detents, drag follows the finger and snaps
  const gesture = useRef<{ id: number; y: number; h: number; t: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null);
  const handleDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (landscape || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, y: e.clientY, h: heights[detent], t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
  };
  const handleMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.abs(dy) < 6) return;
    g.moved = true;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.v = (e.clientY - g.lastY) / dt;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    setDrag(Math.min(heights.full, Math.max(heights.peek, g.h - dy)));
  };
  const handleUp = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.moved) {
      setDetent(snapDetent(drag ?? g.h, vh, g.v));
      setDrag(null);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
    }
  };
  const suppressClick = useRef(false);
  const step = () => {
    if (suppressClick.current) return;
    if (landscape) setSideOpen((o) => !o);
    else setDetent((d) => (d === 'peek' ? 'half' : d === 'half' ? 'full' : 'half'));
  };
  const handleLabel = landscape ? t(sideOpen ? 'sheet.close' : 'sheet.open') : t(detent === 'peek' ? 'sheet.open' : detent === 'half' ? 'sheet.grow' : 'sheet.shrink');

  const body = (
    <div {...tabs.panel(tab)} key={tab} className="anim-fade flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1">
      {tab === 'bench' && <LeftPanel bare />}
      {tab === 'console' && <ConsolePanel />}
      {tab === 'apps' && (
        <ScrollArea className="-mx-1 min-h-0 flex-1 px-1 py-1" label={t('nav.apps')}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <RunButtons labels="always" />
            </div>
            <AppsList onRun={landscape ? undefined : () => setDetent('peek')} />
          </div>
        </ScrollArea>
      )}
      {tab === 'settings' && <Settings />}
    </div>
  );

  const header = (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
      <div {...tabs.list} aria-label={t('sheet.title')} className="flex min-w-0 flex-1 gap-1">
        {TABS.map((id) => (
          <button key={id} {...tabs.tab(id)} aria-selected={open && tab === id} aria-label={t(`nav.${id}` as 'nav.bench')} className="chip min-w-0 flex-1 !px-1.5 !text-[13.5px]" data-testid={`tab-${id}`}>
            <span className="truncate">{t(id === 'bench' ? 'nav.bench.short' : (`nav.${id}` as 'nav.console'))}</span>
          </button>
        ))}
      </div>
      {open && (
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={close} data-testid="sheet-close" aria-label={t('sheet.close')} title={t('sheet.close')}>
          <Icon name={landscape ? 'close' : 'chevronDown'} />
        </button>
      )}
    </div>
  );

  if (landscape) {
    return (
      <>
        {!sideOpen && (
          <button
            type="button"
            data-testid="sheet-handle"
            aria-label={handleLabel}
            aria-expanded={false}
            aria-controls="sheet"
            onClick={step}
            className="absolute right-0 top-1/2 z-20 flex h-28 w-11 -translate-y-1/2 items-center justify-center rounded-l-2xl border-0 bg-card"
            style={{ right: 'env(safe-area-inset-right)' }}
          >
            <span aria-hidden className="h-10 w-1 rounded-full bg-ink/40" />
          </button>
        )}
        <aside
          id="sheet"
          ref={ref}
          aria-label={t('sheet.title')}
          data-testid="sheet"
          data-open={sideOpen}
          inert={!sideOpen}
          className="panel-slot relative z-30 flex min-h-0 shrink-0 flex-col overflow-hidden"
          style={{ width: sideOpen ? 'min(60vw, calc(100vw - 16.5rem))' : 0, opacity: sideOpen ? 1 : 0 }}
        >
          <div className="flex h-full min-h-0 flex-col rounded-l-3xl bg-card pt-3" style={{ width: 'min(60vw, calc(100vw - 16.5rem))', paddingTop: 'max(12px, env(safe-area-inset-top))', paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            {header}
            {/* landscape has no room under the device: the first-visit hint opens the panel instead */}
            <WelcomeHint variant="panel" />
            {body}
          </div>
        </aside>
      </>
    );
  }

  return (
    <aside
      id="sheet"
      ref={ref}
      aria-label={t('sheet.title')}
      data-testid="sheet"
      data-open={open}
      data-detent={detent}
      data-layer="sheet"
      className="absolute inset-x-0 bottom-0 z-40 flex min-h-0 flex-col rounded-t-3xl bg-card shadow-[0_-6px_24px_rgba(40,25,10,0.14)]"
      style={{
        height: `min(calc(${height}px + env(safe-area-inset-bottom)), calc(100dvh - env(safe-area-inset-top) - 32px))`,
        paddingBottom: 'env(safe-area-inset-bottom)',
        transition: drag === null ? 'height var(--dur) var(--ease)' : 'none',
      }}
    >
      {showHint && (
        <div ref={hintRef} className="absolute inset-x-0" style={{ bottom: `calc(100% + ${HANDLE_ABOVE}px)` }}>
          <WelcomeHint variant="bar" />
        </div>
      )}
      <button
        type="button"
        data-testid="sheet-handle"
        aria-label={handleLabel}
        aria-expanded={open}
        aria-controls="sheet"
        onClick={step}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        className="absolute inset-x-0 z-10 mx-auto flex h-11 w-32 cursor-grab touch-none items-end justify-center border-0 bg-transparent pb-2"
        style={{ top: -HANDLE_ABOVE }}
      >
        <span aria-hidden className="h-1 w-10 rounded-full bg-ink/40" />
      </button>
      <div className="h-5 shrink-0" />
      {header}
      {/* closed: the content is not reachable by Tab, by touch or by assistive technology */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" inert={!open} aria-hidden={!open}>
        {body}
      </div>
    </aside>
  );
}

function Settings() {
  const { t } = useI18n();
  const { viewMode, setViewMode, glFailed, wakeLock, setWakeLock } = useHost();
  return (
    <ScrollArea className="-mx-1 min-h-0 flex-1 px-1 py-1" label={t('nav.settings')}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="tag">{t('device.view')}</span>
          <div className="seg self-start" role="group" aria-label={t('device.view')}>
            <button type="button" className="chip" aria-pressed={viewMode === '3d'} disabled={glFailed} onClick={() => setViewMode('3d')} data-testid="settings-view-3d">
              3D
            </button>
            <button type="button" className="chip" aria-pressed={viewMode === '2d'} onClick={() => setViewMode('2d')} data-testid="settings-view-2d">
              2D
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="tag">{t('lang.label')}</span>
          <LanguageSelect />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="tag">{t('settings.appearance')}</span>
          <ThemeChoice />
        </div>
        <label className="flex cursor-pointer items-center gap-3 text-[14px]">
          <input type="checkbox" className="switch" checked={wakeLock} onChange={(e) => setWakeLock(e.target.checked)} />
          <span className="min-w-0">
            <span className="font-semibold">{t('settings.wake')}</span>
            <span className="block text-[13px] leading-snug text-ink2">{t('settings.wake.hint')}</span>
          </span>
        </label>
        <ModelControls />
        <DeviceActions />
        <MockToggle />
        <About />
      </div>
    </ScrollArea>
  );
}
