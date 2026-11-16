import { useRef, useState } from 'react';
import { isRealDevice } from '../device/wasm';
import { useI18n } from '../i18n';
import { KEY_HINT } from '../lib/keys';
import { useHost } from '../state/host';
import { useObservable, useTick } from '../state/hooks';
import { Icon } from './Glyphs';
import { useCurrentAppName } from './TopBar';
import { Popover } from './ui';

const DOT: Record<string, string> = { idle: 'bg-ink3', booting: 'bg-primary', running: 'bg-ok', crashed: 'bg-err' };
/** Below this many redraws per second the screen counts as steady (a clock ticking once a second is not an animation). */
// 0 to 2 per second is what an idle LVGL app does; anything faster is shown as a frame rate.
export const STEADY_BELOW_FPS = 5;

/**
 * One calm row under the stage: what runs, what the device's outputs are doing (LED, vibration, backlight) and,
 * on the right, help and the technical read-outs for those who want them.
 */
export function StatusBar({ show3d }: { show3d: boolean }) {
  const { t, fmt } = useI18n();
  const { device, painter, useMock } = useHost();
  const status = useObservable(device.status);
  const name = useCurrentAppName();
  const led = useObservable(device.led);
  const haptic = useObservable(device.haptic);
  const backlight = useObservable(device.backlight);
  const panelOn = useObservable(device.panelOn);
  useTick(500);
  const fps = painter.fps;
  const steady = fps < STEADY_BELOW_FPS;
  const on = led.r + led.g + led.b > 0;
  const rgb = `rgb(${led.r}, ${led.g}, ${led.b})`;
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

  return (
    <footer className="@container flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 pt-2" data-testid="status-bar" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
      <span className="pill max-w-full">
        <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[status]}`} />
        <span className="font-semibold" data-testid="status-state" data-status={status}>
          {t(`status.${status}` as 'status.idle')}
        </span>
        {name && (
          <span className="truncate text-ink2" data-testid="status-app" title={name}>
            {name}
          </span>
        )}
      </span>
      <span className="pill" title={t('status.screen.hint', { count: fps })}>
        <b>{t('status.screen')}</b>
        <span data-testid="status-fps" data-fps={fps}>
          {status !== 'running' ? t('hud.off') : steady ? t('status.screen.steady') : t('status.screen.fps', { fps })}
        </span>
      </span>
      <span className="pill" title={t('hud.led')}>
        <b>{t('hud.led')}</b>
        <span
          data-testid="led"
          data-color={rgb}
          role="img"
          aria-label={`${t('hud.led')}: ${on ? rgb : t('hud.off')}`}
          className="inline-block h-3 w-3 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ink)_35%,transparent)]"
          style={{ background: on ? rgb : 'transparent', boxShadow: on ? `0 0 8px 1px ${rgb}` : undefined }}
        />
      </span>
      <span className="pill">
        <b>{t('hud.haptic')}</b>
        <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-ink/15" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(haptic.toFixed(2))} aria-label={t('hud.haptic')}>
          <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${haptic * 100}%` }} />
        </span>
      </span>
      <span className="pill">
        <b>{t('hud.backlight')}</b>
        <span className="tabular-nums" data-testid="backlight">
          {panelOn ? `${fmt.number(backlight)}%` : t('hud.off')}
        </span>
      </span>
      {useMock && (
        <span className="pill" title={t('mock.hint')} data-testid="status-mock">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
          {t('status.mock')}
        </span>
      )}
      {!isolated && !useMock && (
        <span className="pill font-semibold !text-redtext" title={t('status.isolated.hint')} data-testid="status-not-isolated">
          {t('status.notIsolated')}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      <KeysHelp show3d={show3d} />
      <Details isolated={isolated} />
    </footer>
  );
}

/** Keyboard and pointer help as a popover: it does not move the device when it opens. */
function KeysHelp({ show3d }: { show3d: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const rows: [string, string][] = [
    [KEY_HINT.top, t('device.btn.top')],
    [KEY_HINT.bottom, t('device.btn.bottom')],
    ['← ↑ ↓ →', t('hud.dpad')],
  ];
  return (
    <>
      <button ref={btn} type="button" className="pill" aria-expanded={open} aria-haspopup="dialog" aria-label={t('device.hints')} title={t('device.hints')} onClick={() => setOpen((o) => !o)} data-testid="hints-toggle">
        <Icon name="keyboard" size={17} />
        <span className="hidden @[900px]:inline">{t('device.hints')}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t('device.hints')} width="19rem" align="end" testid="hints-popover">
        <div className="flex flex-col gap-3">
          <h2 className="text-[17px]">{t('device.hints')}</h2>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[14px]">
            {rows.map(([k, label]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg bg-raised px-2 font-sans text-[13px] font-semibold">{k}</kbd>
                </dt>
                <dd className="m-0">{label}</dd>
              </div>
            ))}
          </dl>
          <p className="m-0 text-[13.5px] leading-snug text-ink2">{t(show3d ? 'device.hint3d' : 'device.hint2d')}</p>
        </div>
      </Popover>
    </>
  );
}

/** Technical read-outs, out of the way until asked for. */
function Details({ isolated }: { isolated: boolean }) {
  const { t, fmt } = useI18n();
  const { device } = useHost();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const real = isRealDevice(device) ? device : null;
  const stats = open ? real?.stats() : undefined;
  return (
    <>
      <button ref={btn} type="button" className="pill" aria-expanded={open} aria-haspopup="dialog" aria-label={t('status.details')} title={t('status.details')} onClick={() => setOpen((o) => !o)} data-testid="status-details-toggle">
        <Icon name="info" size={17} />
        <span className="hidden @[900px]:inline">{t('status.details')}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t('status.details')} width="20rem" align="end" testid="status-details">
        <div className="flex flex-col gap-3">
          <h2 className="text-[17px]">{t('status.details')}</h2>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[14px]">
            <dt className="text-ink2">{t('status.time')}</dt>
            <dd className="m-0 text-right tabular-nums">{fmt.time(device.time())}</dd>
            <dt className="text-ink2">{t('status.device')}</dt>
            <dd className="m-0 text-right">{real ? t('status.device.real') : t('status.mock')}</dd>
            {stats && (
              <>
                <dt className="text-ink2">{t('status.workers')}</dt>
                <dd className="m-0 text-right tabular-nums" data-testid="status-workers">
                  {fmt.number(stats.workers)}
                </dd>
                <dt className="text-ink2">{t('status.memory')}</dt>
                <dd className="m-0 text-right tabular-nums" data-testid="status-memory">
                  {fmt.number(Math.round(stats.memoryBytes / 1048576))} MB
                </dd>
              </>
            )}
            <dt className="text-ink2">{t('status.isolated')}</dt>
            <dd className={`m-0 text-right font-semibold ${isolated ? 'text-oktext' : 'text-redtext'}`} data-testid="status-isolated" data-value={isolated}>
              {t(isolated ? 'status.yes' : 'status.no')}
            </dd>
          </dl>
          <p className="m-0 text-[13px] leading-snug text-ink2">{t('status.isolated.hint')}</p>
        </div>
      </Popover>
    </>
  );
}
