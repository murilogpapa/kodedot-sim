/**
 * The page's side of "which 3D model". The store itself (parsing the GLB, keeping it in this browser, feeding the 3D
 * view) belongs to the 3D model code in src/device3d/customModel.ts; this file only knows its contract and turns its
 * state into what the menu shows. Pure (it does not import the store: state/host.tsx hands it over), so it is
 * unit-tested with fake stores (modelChoice.test.ts).
 */
export interface CustomModelState {
  status: 'none' | 'loading' | 'ready' | 'error';
  name?: string;
  sizeBytes?: number;
  error?: string;
  warnings?: string[];
  // ---- what the store adds to the base contract; all optional here, the menu shows what is reported
  /** Which built-in model is used while there is no user model. */
  builtin?: string;
  /** The bundled maker's model: not looked for yet, being loaded, usable, absent or broken. */
  bundled?: 'unknown' | 'loading' | 'ready' | 'missing' | 'error';
  /** Simpler materials for loaded models (faster). */
  performance?: boolean;
  /** A store may also report its choices outright, with its own labels. */
  options?: { id: string; label: string; custom?: boolean }[];
  selected?: string;
}

export interface CustomModelStore {
  getState(): CustomModelState;
  subscribe(listener: () => void): () => void;
  load(file: File | Blob, name?: string): Promise<void>;
  remove(): Promise<void>;
  setBuiltin?(choice: 'kode' | 'simple'): void;
  setOptions?(o: { performance?: boolean }): Promise<void> | void;
  select?(id: string): Promise<void> | void;
}

export const NO_MODEL: CustomModelState = { status: 'none' };

export function isModelStore(x: unknown): x is CustomModelStore {
  const s = x as Partial<CustomModelStore> | null | undefined;
  return !!s && typeof s.getState === 'function' && typeof s.subscribe === 'function' && typeof s.load === 'function' && typeof s.remove === 'function';
}

// ------------------------------------------------------------------ choices

/** Ids the page has its own (translated) label for; any other option shows the label the store gave it. */
export const KNOWN_OPTION_LABELS = { kode: 'model.option.kode', simple: 'model.option.simple', custom: 'model.option.own' } as const;
export type KnownOptionId = keyof typeof KNOWN_OPTION_LABELS;

export interface ModelOption {
  id: string;
  /** Label reported by the store, when it reported one. */
  label?: string;
  /** Translation key, for the options the page knows. */
  labelKey?: (typeof KNOWN_OPTION_LABELS)[KnownOptionId];
  /** True for "a file of my own": picking it opens the file picker while no file is loaded. */
  custom: boolean;
}

/**
 * The models to choose from, as the store reports them:
 *  - an explicit `options` list wins (labels from the store);
 *  - else the `builtin` / `bundled` fields: the maker's model (hidden when the bundled file is absent or broken),
 *    the simple model, and "my own";
 *  - else nothing: the entry then only offers "use my own" and "back to built-in".
 */
export function optionsOf(state: CustomModelState | null | undefined): { options: ModelOption[]; selected: string | null } {
  const raw = Array.isArray(state?.options) ? state.options : [];
  if (raw.length) {
    const seen = new Set<string>();
    const options: ModelOption[] = [];
    for (const o of raw) {
      if (!o || typeof o.id !== 'string' || !o.id || typeof o.label !== 'string' || !o.label.trim() || seen.has(o.id)) continue;
      seen.add(o.id);
      options.push({ id: o.id, label: o.label.trim(), custom: o.custom === true });
    }
    return { options, selected: typeof state?.selected === 'string' && seen.has(state.selected) ? state.selected : null };
  }
  if (!state || typeof state.builtin !== 'string') return { options: [], selected: null };
  const kodeUsable = state.bundled !== 'missing' && state.bundled !== 'error';
  const options: ModelOption[] = [];
  if (kodeUsable) options.push({ id: 'kode', labelKey: KNOWN_OPTION_LABELS.kode, custom: false });
  options.push({ id: 'simple', labelKey: KNOWN_OPTION_LABELS.simple, custom: false }, { id: 'custom', labelKey: KNOWN_OPTION_LABELS.custom, custom: true });
  const own = state.status === 'ready' || state.status === 'loading';
  return { options, selected: own ? 'custom' : state.builtin === 'kode' && kodeUsable ? 'kode' : 'simple' };
}

// ------------------------------------------------------------------ dropped files

export type DropKind = 'app' | 'model' | 'other';

/** What a dropped or picked file is, by its name: a .dotbench app, a .glb model, or something the page cannot use. */
export function classifyFile(name: string): DropKind {
  if (/\.dotbench$/i.test(name)) return 'app';
  if (/\.glb$/i.test(name)) return 'model';
  return 'other';
}

// ------------------------------------------------------------------ controller

export type ModelView =
  | { kind: 'builtin' }
  | { kind: 'loading'; name: string }
  | { kind: 'custom'; name: string; sizeBytes: number | null; warnings: string[] }
  /** `fallback` says what the 3D view shows meanwhile: the built-in model. */
  | { kind: 'error'; name: string; message: string; warnings: string[] };

/** The store's state as the menu shows it. Unknown or half-filled states fall back to the built-in model. */
export function viewOf(state: CustomModelState | null | undefined): ModelView {
  const s = state ?? NO_MODEL;
  const name = (s.name ?? '').trim();
  const warnings = Array.isArray(s.warnings) ? s.warnings.filter((w) => typeof w === 'string' && w.trim()) : [];
  switch (s.status) {
    case 'loading':
      return { kind: 'loading', name };
    case 'ready':
      return { kind: 'custom', name: name || 'model.glb', sizeBytes: typeof s.sizeBytes === 'number' ? s.sizeBytes : null, warnings };
    case 'error':
      return { kind: 'error', name, message: (s.error ?? '').trim(), warnings };
    default:
      return { kind: 'builtin' };
  }
}

export type UseResult = { ok: true } | { ok: false; reason: 'unavailable' | 'not-glb' | 'failed'; message?: string };

/**
 * Wraps the (possibly missing) store: one subscription point for React, extension check before a load, and no
 * rejected promise ever reaching the UI (the store's own `error` state carries the message).
 */
export class ModelController {
  private store: CustomModelStore | null = null;
  private off: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CustomModelState = NO_MODEL;

  get available(): boolean {
    return this.store !== null;
  }

  /** Attach the store (or detach with null). Subscribers are told. */
  setStore(store: CustomModelStore | null): void {
    this.off?.();
    this.off = null;
    this.store = store;
    this.refresh();
    if (store) this.off = store.subscribe(() => this.refresh());
  }

  getState = (): CustomModelState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async use(file: File | Blob, name = file instanceof File ? file.name : 'model.glb'): Promise<UseResult> {
    if (!this.store) return { ok: false, reason: 'unavailable' };
    if (classifyFile(name) !== 'model') return { ok: false, reason: 'not-glb' };
    try {
      await this.store.load(file, name);
    } catch (e) {
      this.refresh();
      return { ok: false, reason: 'failed', message: String((e as Error)?.message ?? e) };
    }
    this.refresh();
    const s = this.snapshot;
    return s.status === 'error' ? { ok: false, reason: 'failed', message: s.error } : { ok: true };
  }

  /**
   * Switch to one of the reported options. A store with `select` gets the id; one with `setBuiltin` gets 'kode' or
   * 'simple', after the user's own model was removed (it is shown instead of the built-in ones until then).
   * False when the store cannot do it.
   */
  async choose(id: string): Promise<boolean> {
    const store = this.store;
    if (!store) return false;
    try {
      if (typeof store.select === 'function') await store.select(id);
      else if (typeof store.setBuiltin === 'function' && (id === 'kode' || id === 'simple')) {
        if (store.getState().status !== 'none') await store.remove();
        store.setBuiltin(id);
      } else return false;
    } catch {
      this.refresh();
      return false;
    }
    this.refresh();
    return true;
  }

  /** Simpler, faster materials for a loaded model, when the store has that switch. */
  async setPerformance(on: boolean): Promise<void> {
    try {
      await this.store?.setOptions?.({ performance: on });
    } catch {
      /* the store reports its own state */
    }
    this.refresh();
  }

  async reset(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.remove();
    } catch {
      /* the store reports its own state */
    }
    this.refresh();
  }

  private refresh(): void {
    let next: CustomModelState = NO_MODEL;
    try {
      next = this.store?.getState() ?? NO_MODEL;
    } catch {
      next = NO_MODEL;
    }
    // keep the reference stable while nothing changed (useSyncExternalStore)
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const l of [...this.listeners]) l();
  }
}
