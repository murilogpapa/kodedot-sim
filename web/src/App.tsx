import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useI18n } from './i18n';
import { useLayer } from './lib/layers';
import { PANEL_LIMITS, isPhone, panelWidths, planPanels, useViewport, type PanelId, type PanelPlacement } from './lib/layout';
import { loadPref, savePref } from './lib/prefs';
import { useHost } from './state/host';
import { useObservable } from './state/hooks';
import { ConsolePanel } from './components/ConsolePanel';
import { DevicePane, type PanelControl } from './components/DevicePane';
import { Icon } from './components/Glyphs';
import { LeftPanel } from './components/LeftPanel';
import { Sheet } from './components/Sheet';
import { StatusBar } from './components/StatusBar';
import { PRODUCT_NAME, TopBar, useCurrentAppName } from './components/TopBar';
import { useCoarsePointer } from './components/ui';

/** Accepts .dotbench files dropped anywhere on the window. */
function useWindowDrop() {
  const { openFile } = useHost();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (isFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (f) openFile(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFile]);
  return dragging;
}

/** Announces device status changes to screen readers (the visible pill alone is not announced). */
function StatusAnnouncer() {
  const { t } = useI18n();
  const { device } = useHost();
  const status = useObservable(device.status);
  const name = useCurrentAppName();
  const [text, setText] = useState('');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setText(name ? t('status.announce', { app: name, state: t(`status.${status}` as 'status.idle') }) : t(`status.${status}` as 'status.idle'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="status-live">
      {text}
    </div>
  );
}

// ------------------------------------------------------------------ side cards

/**
 * One side card in either placement. Docked: a column whose width animates to zero when collapsed. Drawer: the same
 * card sliding over the stage from its own side, with a scrim; Escape closes it and focus returns to its toggle.
 */
function PanelSlot({ id, placement, open, width, resizing, onClose, children }: { id: PanelId; placement: PanelPlacement; open: boolean; width: number; resizing: boolean; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawer = placement === 'drawer';
  useLayer(drawer && open, onClose, ref, { dismissOutside: false });
  const left = id === 'bench';
  // while a docked card collapses, its content keeps the width it had (no reflow during the animation)
  const lastWidth = useRef(width || PANEL_LIMITS[id].min);
  if (open && width) lastWidth.current = width;
  if (drawer) {
    const w = left ? 'min(22rem, calc(100% - 24px))' : 'min(27rem, calc(100% - 24px))';
    return (
      <div
        ref={ref}
        id={`panel-${id}`}
        inert={!open}
        data-testid={`drawer-${id}-panel`}
        data-open={open}
        data-layer="drawer"
        data-placement="drawer"
        className={`slide absolute bottom-0 top-0 z-40 flex min-h-0 flex-col rounded-3xl shadow-[var(--shadow-pop)] ${left ? 'left-3' : 'right-3'}`}
        style={{ width: w, transform: open ? 'none' : `translateX(${left ? '-' : ''}calc(100% + 24px))`, visibility: open ? 'visible' : 'hidden' }}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      id={`panel-${id}`}
      inert={!open}
      data-testid={`drawer-${id}-panel`}
      data-open={open}
      data-placement="dock"
      className={`${resizing ? '' : 'panel-slot'} relative flex min-h-0 shrink-0 overflow-hidden ${left ? 'justify-end' : 'justify-start'}`}
      style={{ width: open ? width : 0, opacity: open ? 1 : 0 }}
    >
      <div className="flex min-h-0 shrink-0 flex-col" style={{ width: lastWidth.current }}>
        {children}
      </div>
    </div>
  );
}

/** The gutter between a docked card and the stage: drag it, or focus it and use the arrow keys, to resize the card. */
function Splitter({ id, width, onResize, onCommit, setResizing }: { id: PanelId; width: number; onResize(w: number | null): void; onCommit(): void; setResizing(v: boolean): void }) {
  const { t } = useI18n();
  const coarse = useCoarsePointer();
  const start = useRef<{ x: number; w: number } | null>(null);
  const dir = id === 'bench' ? 1 : -1;
  const lim = PANEL_LIMITS[id];
  if (coarse) return <div className="w-3 shrink-0" aria-hidden />;
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setResizing(true);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (start.current) onResize(start.current.w + (e.clientX - start.current.x) * dir);
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    setResizing(false);
    onCommit();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const stepPx = e.shiftKey ? 64 : 16;
    let next: number | null | undefined;
    if (e.key === 'ArrowLeft') next = width - stepPx * dir;
    else if (e.key === 'ArrowRight') next = width + stepPx * dir;
    else if (e.key === 'Home') next = lim.min;
    else if (e.key === 'End') next = lim.max;
    else if (e.key === 'Enter') next = null;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onResize(next);
    onCommit();
  };
  const label = t('panel.resize', { panel: t(id === 'bench' ? 'nav.bench' : 'nav.console') });
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={lim.min}
      aria-valuemax={lim.max}
      aria-valuenow={Math.round(width)}
      aria-controls={`panel-${id}`}
      title={t('panel.resize.hint')}
      tabIndex={0}
      data-testid={`splitter-${id}`}
      className="group relative z-10 -mx-1.5 flex w-6 shrink-0 cursor-col-resize touch-none items-center justify-center !rounded-xl"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        onResize(null);
        onCommit();
      }}
      onKeyDown={key}
    >
      <span aria-hidden className="h-10 w-1 rounded-full bg-ink/0 transition-colors duration-150 group-hover:bg-ink/30 group-focus-visible:bg-ink/30 group-active:bg-ink/50" />
    </div>
  );
}

function DeskShell() {
  const { t } = useI18n();
  const { layout, viewMode, glFailed } = useHost();
  const vp = useViewport();
  const plan = planPanels(vp.w);
  const [dockOpen, setDockOpen] = useState<Record<PanelId, boolean>>(() => ({ bench: loadPref<boolean>('dotbench.panel.bench', true) !== false, console: loadPref<boolean>('dotbench.panel.console', true) !== false }));
  const [drawer, setDrawer] = useState<PanelId | null>(null);
  const [saved, setSaved] = useState<Record<PanelId, number | null>>(() => {
    const read = (k: string) => {
      const v = loadPref<unknown>(k, null);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return { bench: read('dotbench.panel.bench.w'), console: read('dotbench.panel.console.w') };
  });
  const [resizing, setResizing] = useState(false);

  // a drawer that became a docked column (window grew) is no longer "open as a drawer"
  useEffect(() => {
    if (drawer && plan[drawer] === 'dock') setDrawer(null);
  }, [drawer, plan]);

  const isOpen = (id: PanelId) => (plan[id] === 'dock' ? dockOpen[id] : drawer === id);
  const setOpen = useCallback(
    (id: PanelId, open: boolean) => {
      if (plan[id] === 'dock') {
        setDockOpen((d) => ({ ...d, [id]: open }));
        savePref(`dotbench.panel.${id}`, open);
      } else setDrawer(open ? id : null);
    },
    [plan],
  );
  const widths = panelWidths(vp.w, saved, { bench: plan.bench === 'dock' && dockOpen.bench, console: plan.console === 'dock' && dockOpen.console });
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const control = (id: PanelId): PanelControl => ({ open: isOpen(id), placement: plan[id], toggle: () => setOpen(id, !isOpen(id)) });
  const splitter = (id: PanelId) =>
    plan[id] === 'dock' && dockOpen[id] ? (
      <Splitter
        id={id}
        width={widths[id]}
        setResizing={setResizing}
        onResize={(w) => setSaved((s) => ({ ...s, [id]: w === null ? null : Math.min(PANEL_LIMITS[id].max, Math.max(PANEL_LIMITS[id].min, w)) }))}
        onCommit={() => setTimeout(() => savePref(`dotbench.panel.${id}.w`, savedRef.current[id]), 0)}
      />
    ) : null;
  const hide = (id: PanelId) => t('panel.hide', { panel: t(id === 'bench' ? 'nav.bench' : 'nav.console') });

  return (
    <div className="flex h-full min-h-0 flex-col [overflow:clip]" data-layout={layout} data-testid="desk-root">
      <a className="skip-link btn btn-primary" href="#device" data-layer="skip">
        {t('nav.skip')}
      </a>
      <TopBar />
      <div className="relative flex min-h-0 flex-1 px-3">
        <PanelSlot id="bench" placement={plan.bench} open={isOpen('bench')} width={widths.bench} resizing={resizing} onClose={() => setOpen('bench', false)}>
          <LeftPanel onClose={plan.bench === 'drawer' ? () => setOpen('bench', false) : undefined} closeLabel={hide('bench')} />
        </PanelSlot>
        {splitter('bench')}
        <main id="device" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
          <DevicePane panels={{ bench: control('bench'), console: control('console') }} />
        </main>
        {splitter('console')}
        <PanelSlot id="console" placement={plan.console} open={isOpen('console')} width={widths.console} resizing={resizing} onClose={() => setOpen('console', false)}>
          <ConsolePanel onClose={plan.console === 'drawer' ? () => setOpen('console', false) : undefined} closeLabel={hide('console')} />
        </PanelSlot>
        <div
          aria-hidden
          data-testid="drawer-scrim"
          data-layer="scrim"
          className="absolute inset-0 z-30 rounded-3xl transition-opacity duration-200"
          style={{ background: 'var(--scrim)', opacity: drawer ? 1 : 0, pointerEvents: drawer ? 'auto' : 'none' }}
          onPointerDown={() => setDrawer(null)}
        />
      </div>
      <StatusBar show3d={viewMode === '3d' && !glFailed} />
    </div>
  );
}

function PhoneShell() {
  const { layout } = useHost();
  const land = layout === 'phone-landscape';
  const [inset, setInset] = useState({ px: 96, animate: false });
  const onInset = useCallback((px: number, animate: boolean) => setInset((cur) => (cur.px === px && cur.animate === animate ? cur : { px, animate })), []);
  return (
    <main className={`relative flex h-full min-h-0 [overflow:clip] ${land ? 'flex-row' : 'flex-col'}`} data-testid="phone-root" data-layout={layout}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={land ? undefined : { paddingBottom: `calc(${inset.px}px + env(safe-area-inset-bottom))`, transition: inset.animate ? 'padding-bottom var(--dur) var(--ease)' : 'none' }}
      >
        <DevicePane />
      </div>
      <Sheet landscape={land} onInset={onInset} />
    </main>
  );
}

export default function App() {
  const { t } = useI18n();
  const { layout } = useHost();
  const dragging = useWindowDrop();
  useEffect(() => {
    document.title = `${PRODUCT_NAME} · ${t('app.descriptor')}`;
  }, [t]);
  return (
    <>
      {isPhone(layout) ? <PhoneShell /> : <DeskShell />}
      <StatusAnnouncer />
      {dragging && <DropOverlay />}
    </>
  );
}

/** While a file is dragged over the page: what will happen to each kind of file, before it is dropped. */
function DropOverlay() {
  const { t } = useI18n();
  const { model } = useHost();
  const rows: { icon: 'open' | 'cube'; title: string; hint: string }[] = [{ icon: 'open', title: t('drop.app'), hint: t('drop.app.hint') }];
  if (model.available) rows.push({ icon: 'cube', title: t('drop.model'), hint: t('drop.model.hint') });
  return (
    <div className="anim-fade pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-bg/85 p-4" data-testid="drop-overlay" data-layer="drop">
      <div className="flex w-full max-w-[27rem] flex-col gap-3 rounded-3xl bg-card p-6 shadow-[inset_0_0_0_2px_var(--ink)]">
        <strong className="font-heading text-[20px] font-bold leading-snug">{t('apps.dropOverlay')}</strong>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.title} className="inner flex items-center gap-3 p-3">
              <span className="icon-tile bg-primary !text-primaryink" style={{ width: 40, height: 40 }}>
                <Icon name={r.icon} size={20} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold">{r.title}</span>
                <span className="block text-[13.5px] leading-snug text-ink2">{r.hint}</span>
              </span>
            </li>
          ))}
        </ul>
        <span className="text-[13.5px] leading-snug text-ink2">{t('drop.rest')}</span>
      </div>
    </div>
  );
}
