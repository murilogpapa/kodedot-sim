/**
 * Which model the 3D view shows, and the user's own model file.
 *
 *   - "kode"   the device maker's model, bundled at /device/model.glb (the default when the file is there)
 *   - "simple" the procedural model built in code (always available; the automatic fallback)
 *   - a model the user loaded from his own computer: kept in this browser only
 *     (IndexedDB), never uploaded anywhere, shown instead of the other two until removed
 *
 * This file is light on purpose (the page imports it for its menu): three.js
 * and the loaders live in ./prepare, imported only when a model is parsed.
 * Nothing here throws into the page: failures end up in the state.
 */
import type { PreparedModel } from './prepare';

export type BuiltinChoice = 'kode' | 'simple';

export interface CustomModelState {
  status: 'none' | 'loading' | 'ready' | 'error';
  name?: string;
  sizeBytes?: number;
  error?: string;
  warnings?: string[];
  // ---- additions to the contract (the menu may ignore them)
  /** which built-in model is chosen for when there is no user model */
  builtin: BuiltinChoice;
  /** the bundled maker's model: not looked for yet, being loaded, usable, absent, or broken */
  bundled: 'unknown' | 'loading' | 'ready' | 'missing' | 'error';
  /** cheap materials and small textures for loaded models (default on); off = the file's own materials */
  performance: boolean;
}

/** What the 3D view should draw right now. `pending`: the chosen model is still loading, draw nothing for a moment. */
export type ActiveModel = { kind: 'simple' } | { kind: 'pending' } | { kind: 'kode' | 'custom'; model: PreparedModel };

export const MAX_MODEL_BYTES = 30 * 1024 * 1024;
export const BUNDLED_URL = '/device/model.glb';
const DB_NAME = 'dotbench-custom-model';
const STORE = 'model';
const KEY = 'current';
const PREF_BUILTIN = 'dotbench.model.builtin';
const PREF_PERF = 'dotbench.model.performance';
/** How long the view waits for the chosen model before showing the simple one meanwhile. */
const PENDING_MS = 2500;

const SUPPORTED_REQUIRED = new Set([
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'EXT_texture_avif', 'KHR_texture_transform',
  'KHR_materials_clearcoat', 'KHR_materials_anisotropy', 'KHR_materials_specular', 'KHR_materials_ior', 'KHR_materials_emissive_strength', 'KHR_materials_sheen',
  'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_iridescence', 'KHR_materials_unlit', 'KHR_materials_dispersion', 'KHR_materials_bump', 'KHR_lights_punctual', 'EXT_mesh_gpu_instancing',
]);

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Checks the container before anything is stored or parsed. Returns a readable reason, or null when it looks fine. */
export function validateGlb(buffer: ArrayBuffer): string | null {
  if (buffer.byteLength > MAX_MODEL_BYTES) return `The file is ${megabytes(buffer.byteLength)}; the limit is ${megabytes(MAX_MODEL_BYTES)}.`;
  if (buffer.byteLength < 20) return 'This is not a GLB file (it is too short).';
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== 0x46546c67) return 'This is not a GLB file (binary glTF). A .gltf with separate files, or another format, has to be exported as .glb first.';
  if (v.getUint32(4, true) !== 2) return `This GLB is glTF version ${v.getUint32(4, true)}; only version 2 is supported.`;
  if (v.getUint32(8, true) > buffer.byteLength) return 'The GLB file is cut short (it is smaller than its header says).';
  const len = v.getUint32(12, true);
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + len > buffer.byteLength) return 'The GLB file is damaged (its first chunk is not the scene description).';
  let json: { meshes?: unknown[]; extensionsRequired?: string[] };
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, len)));
  } catch {
    return 'The GLB file is damaged (its scene description cannot be read).';
  }
  if (!Array.isArray(json.meshes) || json.meshes.length === 0) return 'The GLB file contains no meshes.';
  const unsupported = (json.extensionsRequired ?? []).filter((e) => !SUPPORTED_REQUIRED.has(e));
  if (unsupported.length) return `The file needs ${unsupported.join(', ')}, which this viewer does not support. Export it without ${unsupported.length > 1 ? 'them' : 'it'} (KTX2 textures, for example, as WebP or PNG).`;
  return null;
}

// ------------------------------------------------------------------ storage
interface Stored {
  name: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser has no local storage for files (IndexedDB).'));
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error ?? new Error('Local storage could not be opened.'));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onabort = tx.onerror = () => {
          db.close();
          reject(tx.error ?? req.error ?? new Error('Local storage refused the file.'));
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

const pref = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  },
};

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^THREE\.[A-Za-z]+:\s*/, '');

// -------------------------------------------------------------------- store
class ModelStore {
  private state: CustomModelState = { status: 'none', builtin: pref.get(PREF_BUILTIN) === 'simple' ? 'simple' : 'kode', bundled: 'unknown', performance: pref.get(PREF_PERF) !== 'off' };
  private listeners = new Set<() => void>();
  private custom: PreparedModel | null = null;
  private customBytes: ArrayBuffer | null = null;
  private kode: PreparedModel | null = null;
  private active: ActiveModel = { kind: 'simple' };
  private pendingSince = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private bundledStarted = false;
  private restoring = false;

  getState = (): CustomModelState => this.state;
  getActive = (): ActiveModel => this.active;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<CustomModelState>) {
    const next = { ...this.state, ...patch };
    for (const k of ['name', 'sizeBytes', 'error', 'warnings'] as const) if (next[k] === undefined) delete next[k];
    this.state = next;
    this.refreshActive();
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a listener's problem is not ours */
      }
    }
  }

  private refreshActive() {
    const s = this.state;
    let kind: ActiveModel['kind'] = 'simple';
    if (s.status === 'ready' && this.custom) kind = 'custom';
    else if (s.status === 'loading' && this.restoring) kind = 'pending'; // a fresh load keeps the current model on show meanwhile
    else if (s.builtin === 'kode' && s.bundled === 'ready' && this.kode) kind = 'kode';
    else if (s.builtin === 'kode' && (s.bundled === 'loading' || (s.bundled === 'unknown' && this.bundledStarted))) kind = 'pending';
    if (kind === 'pending') {
      // wait a moment for the real thing rather than flashing the simple model, but not for ever
      if (!this.pendingSince) {
        this.pendingSince = Date.now();
        this.pendingTimer = setTimeout(() => this.set({}), PENDING_MS + 20);
      }
      if (Date.now() - this.pendingSince >= PENDING_MS) kind = this.kode && s.builtin === 'kode' ? 'kode' : 'simple';
    } else {
      this.pendingSince = 0;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const model = kind === 'custom' ? this.custom : kind === 'kode' ? this.kode : null;
    const cur = this.active;
    if (cur.kind === kind && (!model || (cur as { model?: PreparedModel }).model === model)) return;
    this.active = model ? { kind: kind as 'kode' | 'custom', model } : { kind: kind as 'simple' | 'pending' };
  }

  // ---- the user's own file
  async load(file: File | Blob, name?: string): Promise<void> {
    const label = (name ?? (file as File).name ?? 'model.glb').trim() || 'model.glb';
    const gen = ++this.generation;
    this.set({ status: 'loading', name: label, sizeBytes: file.size, error: undefined, warnings: undefined });
    try {
      if (file.size > MAX_MODEL_BYTES) throw new Error(`The file is ${megabytes(file.size)}; the limit is ${megabytes(MAX_MODEL_BYTES)}.`);
      const bytes = await file.arrayBuffer();
      const bad = validateGlb(bytes);
      if (bad) throw new Error(bad);
      const model = await this.parse(bytes);
      if (gen !== this.generation) return model.dispose();
      const warnings = [...model.warnings];
      try {
        await idb('readwrite', (s) => s.put({ name: label, bytes, savedAt: Date.now() } satisfies Stored, KEY));
      } catch (e) {
        warnings.push(`The model is shown, but it could not be saved in this browser (${message(e)}); it will be gone after a reload.`);
      }
      this.swapCustom(model, bytes);
      this.set({ status: 'ready', name: label, sizeBytes: bytes.byteLength, warnings });
    } catch (e) {
      if (gen !== this.generation) return;
      // the previous model, if any, is gone from view: the built-in one shows
      this.swapCustom(null, null);
      this.set({ status: 'error', name: label, error: message(e), warnings: undefined });
    }
  }

  async remove(): Promise<void> {
    ++this.generation;
    this.swapCustom(null, null);
    this.set({ status: 'none', name: undefined, sizeBytes: undefined, error: undefined, warnings: undefined });
    try {
      await idb('readwrite', (s) => s.delete(KEY));
    } catch {
      /* nothing was stored, or storage is unavailable: nothing to remove */
    }
  }

  private swapCustom(model: PreparedModel | null, bytes: ArrayBuffer | null) {
    const old = this.custom;
    this.custom = model;
    this.customBytes = bytes;
    // let the view let go of it first
    if (old && old !== model) setTimeout(() => old.dispose(), 1000);
  }

  private async parse(bytes: ArrayBuffer, performance = this.state.performance): Promise<PreparedModel> {
    const { prepareModel } = await import('./prepare');
    // the loader may keep or detach what it is given: hand it a copy, the original goes to storage
    return prepareModel(bytes.slice(0), { performance });
  }

  /** Start-up: bring back the model saved in this browser, if there is one. */
  async restore(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    const gen = this.generation;
    let rec: Stored | undefined;
    try {
      rec = await idb<Stored | undefined>('readonly', (s) => s.get(KEY));
    } catch {
      return; // storage unavailable: carry on with the built-in model
    }
    if (!rec || !(rec.bytes instanceof ArrayBuffer) || gen !== this.generation) return;
    this.restoring = true;
    this.set({ status: 'loading', name: rec.name, sizeBytes: rec.bytes.byteLength });
    try {
      const bad = validateGlb(rec.bytes);
      if (bad) throw new Error(bad);
      const model = await this.parse(rec.bytes);
      if (gen !== this.generation) return model.dispose();
      this.swapCustom(model, rec.bytes);
      this.restoring = false;
      this.set({ status: 'ready', name: rec.name, sizeBytes: rec.bytes.byteLength, warnings: [...model.warnings] });
    } catch (e) {
      this.restoring = false;
      if (gen !== this.generation) return;
      this.set({ status: 'error', name: rec.name, error: `The saved model could not be opened: ${message(e)}`, warnings: undefined });
    }
  }

  /** Measuring and tests only: show an already prepared model as the user's, without storing it. */
  debugShow(model: PreparedModel, name: string): void {
    ++this.generation;
    this.swapCustom(model, null);
    this.set({ status: 'ready', name, sizeBytes: undefined, error: undefined, warnings: [...model.warnings] });
  }

  // ---- options
  getOptions = () => ({ performance: this.state.performance });

  /** Cheap materials on or off for loaded models; the current user model is rebuilt. */
  async setOptions(o: { performance?: boolean }): Promise<void> {
    if (o.performance === undefined || o.performance === this.state.performance) return;
    pref.set(PREF_PERF, o.performance ? 'on' : 'off');
    this.set({ performance: o.performance });
    const bytes = this.customBytes;
    if (!bytes || this.state.status !== 'ready') return;
    const gen = ++this.generation;
    try {
      const model = await this.parse(bytes, o.performance);
      if (gen !== this.generation) return model.dispose();
      this.swapCustom(model, bytes);
      this.set({ warnings: [...model.warnings] });
    } catch (e) {
      if (gen === this.generation) this.set({ status: 'error', error: message(e) });
    }
  }

  // ---- built-in models
  getBuiltin = (): BuiltinChoice => this.state.builtin;

  setBuiltin(choice: BuiltinChoice): void {
    if (choice !== 'kode' && choice !== 'simple') return;
    pref.set(PREF_BUILTIN, choice);
    this.set({ builtin: choice });
    if (choice === 'kode') void this.ensureBundled();
  }

  /** Called by the 3D view when it appears: fetch and prepare the bundled model once. Any failure means "simple". */
  async ensureBundled(): Promise<void> {
    if (this.bundledStarted || this.state.builtin !== 'kode') return;
    this.bundledStarted = true;
    this.set({ bundled: 'loading' });
    try {
      const res = await fetch(BUNDLED_URL);
      const bytes = res.ok ? await res.arrayBuffer() : null;
      // a missing file may come back as the page's own HTML
      if (!bytes || bytes.byteLength < 20 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) return this.set({ bundled: 'missing' });
      const bad = validateGlb(bytes);
      if (bad) throw new Error(bad);
      const { prepareModel } = await import('./prepare');
      this.kode = await prepareModel(bytes, { performance: true });
      this.set({ bundled: 'ready' });
    } catch (e) {
      console.warn(`[dotbench] ${BUNDLED_URL} could not be used (${message(e)}); showing the simple model`);
      this.set({ bundled: 'error' });
    }
  }
}

export const customModel = new ModelStore();
if (typeof window !== 'undefined') void customModel.restore();
