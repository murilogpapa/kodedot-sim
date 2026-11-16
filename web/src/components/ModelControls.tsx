import { useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import { useLayer } from '../lib/layers';
import { optionsOf, viewOf, type ModelOption } from '../lib/modelChoice';
import { useHost } from '../state/host';
import { Icon } from './Glyphs';

/**
 * "3D model" entry of the Device menu (and of the phone's settings): which model the 3D view shows, a way to use
 * one's own .glb and to go back, with the loading and error states spelled out. Hidden while the 3D code has no
 * model store (the built-in model is then the only one).
 */
export function ModelControls({ onDone }: { onDone?: () => void }) {
  const { t, fmt } = useI18n();
  const { model, applyModelFile } = useHost();
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const file = useRef<HTMLInputElement>(null);
  const [details, setDetails] = useState(false);
  if (!model.available) return null;
  const v = viewOf(state);
  // the store may offer several models (the maker's, a simple one, "my own"): shown as it reports them
  const { options, selected } = optionsOf(state);
  const current = options.find((o) => o.id === selected);
  const labelOf = (o: ModelOption) => o.label ?? (o.labelKey ? t(o.labelKey) : o.id);
  const pick = (o: ModelOption) => {
    if (o.custom && v.kind !== 'custom') return file.current?.click(); // nothing loaded yet: choosing "my own" asks for the file
    void model.choose(o.id);
  };
  const warnings = v.kind === 'custom' || v.kind === 'error' ? v.warnings : [];
  const busy = v.kind === 'loading';
  return (
    <div className="flex flex-col gap-2" data-testid="model-controls" data-state={v.kind}>
      <span className="tag" id="model-title">
        {t('model.title')}
      </span>
      {options.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="model-title" data-testid="model-options">
          {options.map((o) => (
            <button key={o.id} type="button" className="chip" aria-pressed={o.id === selected} disabled={busy} onClick={() => pick(o)} data-testid={`model-option-${o.id}`}>
              {labelOf(o)}
            </button>
          ))}
        </div>
      )}
      <div className="inner flex min-h-11 items-center gap-2.5 px-3.5 py-2" role="status">
        {busy ? (
          <>
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold" title={v.name}>
              {t('model.loading', { name: v.name || '.glb' })}
            </span>
          </>
        ) : v.kind === 'custom' ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold" title={v.name} data-testid="model-name">
              {v.name}
            </span>
            {v.sizeBytes !== null && <span className="shrink-0 text-[12.5px] text-ink2">{fmt.bytes(v.sizeBytes)}</span>}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold" data-testid="model-name">
            {current && !current.custom ? labelOf(current) : t('model.builtin')}
          </span>
        )}
      </div>
      {v.kind === 'error' && (
        <p role="alert" className="m-0 px-1 text-[13.5px] leading-snug text-redtext [overflow-wrap:anywhere]" data-testid="model-error">
          <strong className="font-semibold">{t('model.error', { name: v.name || '.glb' })}</strong> {v.message} {t('model.error.fallback')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => file.current?.click()} data-testid="model-pick">
          <Icon name="cube" size={17} />
          {t('model.use')}
        </button>
        {options.length < 2 && (v.kind === 'custom' || v.kind === 'error') && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void model.reset()} data-testid="model-reset">
            {t('model.reset')}
          </button>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept=".glb,model/gltf-binary"
        hidden
        data-testid="model-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            void applyModelFile(f);
            onDone?.();
          }
        }}
      />
      {v.kind === 'custom' && typeof state.performance === 'boolean' && (
        <label className="flex cursor-pointer items-center gap-3 px-1 text-[14px]">
          <input type="checkbox" className="switch" checked={state.performance} onChange={(e) => void model.setPerformance(e.target.checked)} data-testid="model-performance" />
          <span className="min-w-0">
            <span className="font-semibold">{t('model.performance')}</span>
            <span className="block text-[13px] leading-snug text-ink2">{t('model.performance.hint')}</span>
          </span>
        </label>
      )}
      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          <button type="button" className="btn btn-sm btn-ghost self-start !px-2" aria-expanded={details} onClick={() => setDetails((d) => !d)} data-testid="model-details">
            <Icon name={details ? 'chevronUp' : 'chevronDown'} size={16} />
            {t('model.details', { count: warnings.length })}
          </button>
          {details && (
            <ul className="anim-fade m-0 flex list-disc flex-col gap-1 pl-6 pr-1 text-[13px] leading-snug text-ink2 [overflow-wrap:anywhere]" data-testid="model-warnings">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="m-0 px-1 text-[13px] leading-snug text-ink2" data-testid="model-help">
        {t('model.help')}
      </p>
    </div>
  );
}

/** A dropped .glb asks before it replaces the device in the 3D view. Escape or Cancel leaves everything as it was. */
export function ModelOffer() {
  const { t, fmt } = useI18n();
  const { modelOffer, resolveModelOffer } = useHost();
  const ref = useRef<HTMLDivElement>(null);
  useLayer(!!modelOffer, () => resolveModelOffer(false), ref, { dismissOutside: false });
  if (!modelOffer) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-3" data-testid="model-offer">
      <div ref={ref} role="alertdialog" aria-label={t('model.offer.title')} data-layer="offer" className="layer anim-rise pointer-events-auto flex max-h-full w-full max-w-[23rem] flex-col gap-2 overflow-y-auto p-5" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="text-[19px] leading-snug">{t('model.offer.title')}</h3>
        <p className="m-0 text-[13.5px] leading-snug text-ink2 [overflow-wrap:anywhere]">
          <strong className="font-semibold text-ink">{modelOffer.name}</strong> ({fmt.bytes(modelOffer.size)}). {t('model.offer.body')}
        </p>
        <p className="m-0 text-[13px] leading-snug text-ink2">{t('model.help')}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => resolveModelOffer(true)} data-testid="model-offer-accept">
            {t('model.offer.accept')}
          </button>
          <button type="button" className="btn" onClick={() => resolveModelOffer(false)} data-testid="model-offer-cancel">
            {t('model.offer.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
