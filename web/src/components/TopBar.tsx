import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { appLabel, useHost } from '../state/host';
import { useObservable } from '../state/hooks';
import { AppsList } from './AppsList';
import { DeviceActions } from './DeviceMenu';
import { LanguageSelect, MockToggle, RunButtons, ThemeChoice } from './Controls';
import { Icon } from './Glyphs';
import { ModelControls } from './ModelControls';
import { Popover } from './ui';

/** The product's name as shown to people, the same in every language. Internal identifiers (.dotbench packages, storage keys) keep the old name for now. */
export const PRODUCT_NAME = 'KodeDot Sim';

export function Brand() {
  return (
    // plain text in the heading face: a name, not a logo
    <h1 className="shrink-0 whitespace-nowrap text-[24px] leading-none" data-testid="brand">
      {PRODUCT_NAME}
    </h1>
  );
}

/** One quiet line that says what this page is. */
export function About() {
  const { t } = useI18n();
  return (
    <p className="m-0 text-[13px] leading-snug text-ink2" data-testid="about">
      <strong className="font-semibold text-ink">{PRODUCT_NAME}</strong> · {t('app.descriptor')}
    </p>
  );
}

/** Name shown for what is loaded: the app's own name once it runs, else the saved file's name. */
export function useCurrentAppName(): string | null {
  const { device, selectedId, bundles, builtins } = useHost();
  const app = useObservable(device.appName);
  const sel = bundles.find((b) => b.id === selectedId) ?? builtins.find((b) => `builtin:${b.id}` === selectedId);
  return app ?? (sel ? appLabel(sel.name) : null);
}

function AppPicker() {
  const { t } = useI18n();
  const { appsRequest } = useHost();
  const name = useCurrentAppName();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const seen = useRef(appsRequest);
  useEffect(() => {
    if (appsRequest !== seen.current) {
      seen.current = appsRequest;
      setOpen(true);
    }
  }, [appsRequest]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn min-w-0 !shrink max-w-[19rem]"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('apps.pickerHint', { name: name ?? t('apps.none') })}
        onClick={() => setOpen((o) => !o)}
        data-testid="apps-menu"
      >
        <span className="font-medium text-ink2">{t('apps.pickerLabel')}</span>
        <span className="truncate">{name ?? t('apps.none')}</span>
        <Icon name="chevronDown" size={16} className="text-ink2" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t('apps.title')} width="23rem" testid="apps-popover">
        <AppsList onRun={() => setOpen(false)} />
      </Popover>
    </>
  );
}

function DeviceMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} data-testid="device-menu">
        {t('device.menu')}
        <Icon name="chevronDown" size={16} className="text-ink2" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t('device.menu')} width="21rem" align="end" testid="device-popover">
        <div className="flex flex-col gap-4">
          <ModelControls onDone={() => setOpen(false)} />
          <DeviceActions onDone={() => setOpen(false)} />
          <MockToggle />
        </div>
      </Popover>
    </>
  );
}

function SettingsMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="btn btn-icon" aria-expanded={open} aria-haspopup="dialog" aria-label={t('nav.settings')} title={t('nav.settings')} onClick={() => setOpen((o) => !o)} data-testid="settings-menu">
        <Icon name="settings" size={20} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} label={t('nav.settings')} width="17rem" align="end" testid="settings-popover">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="tag">{t('lang.label')}</span>
            <LanguageSelect />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="tag">{t('settings.appearance')}</span>
            <ThemeChoice />
          </div>
          <About />
        </div>
      </Popover>
    </>
  );
}

/** One row, never wraps: brand, the app and its run controls on the left; device and page settings on the right. */
export function TopBar() {
  return (
    <header className="flex h-[68px] shrink-0 items-center gap-2 px-4" data-testid="top-bar">
      <Brand />
      <div className="w-1 shrink-0" />
      <AppPicker />
      <RunButtons />
      <div className="min-w-0 flex-1" />
      <DeviceMenu />
      <SettingsMenu />
    </header>
  );
}
