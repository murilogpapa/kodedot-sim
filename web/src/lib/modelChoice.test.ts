import { describe, expect, it } from 'vitest';
import { ModelController, NO_MODEL, classifyFile, isModelStore, optionsOf, viewOf, type CustomModelState, type CustomModelStore } from './modelChoice';

/** A fake of the 3D engineer's store, following its contract. */
class FakeStore implements CustomModelStore {
  state: CustomModelState = { status: 'none' };
  listeners = new Set<() => void>();
  loads: string[] = [];
  failWith: string | null = null;
  throwOnLoad = false;
  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(next: CustomModelState) {
    this.state = next;
    for (const l of this.listeners) l();
  }
  async load(file: File | Blob, name = 'model.glb') {
    this.loads.push(name);
    this.set({ status: 'loading', name });
    await Promise.resolve();
    if (this.throwOnLoad) throw new Error('boom');
    if (this.failWith) this.set({ status: 'error', name, error: this.failWith });
    else this.set({ status: 'ready', name, sizeBytes: file.size, warnings: ['no node named "screen": the picture is drawn on the largest flat face'] });
  }
  async remove() {
    this.set({ status: 'none' });
  }
}

/** A store that reports its choices outright, with its own labels. */
class FakeStoreWithOptions extends FakeStore {
  options = [
    { id: 'kode', label: 'Kode model' },
    { id: 'simple', label: 'Simple model' },
    { id: 'custom', label: 'My own…', custom: true },
  ];
  constructor() {
    super();
    this.state = { status: 'none', options: this.options, selected: 'kode' };
  }
  async select(id: string) {
    if (id === 'broken') throw new Error('no such model');
    this.set({ ...this.state, options: this.options, selected: id });
  }
}

/** A store shaped like the 3D code's: a built-in choice, the state of the bundled file, a performance switch. */
class FakeKodeStore extends FakeStore {
  removed = 0;
  constructor(bundled: CustomModelState['bundled'] = 'ready') {
    super();
    this.state = { status: 'none', builtin: 'kode', bundled, performance: true };
  }
  set(next: CustomModelState) {
    super.set({ builtin: this.state.builtin, bundled: this.state.bundled, performance: this.state.performance, ...next });
  }
  setBuiltin(choice: 'kode' | 'simple') {
    this.set({ ...this.state, builtin: choice });
  }
  async setOptions(o: { performance?: boolean }) {
    this.set({ ...this.state, performance: o.performance ?? this.state.performance });
  }
  async remove() {
    this.removed++;
    this.set({ status: 'none' });
  }
}

const glb = (bytes = 2048) => new Blob([new Uint8Array(bytes)]);

describe('classifyFile', () => {
  it('tells apps, models and other files apart by extension, ignoring case', () => {
    expect(classifyFile('blink.dotbench')).toBe('app');
    expect(classifyFile('My App.DOTBENCH')).toBe('app');
    expect(classifyFile('shell.glb')).toBe('model');
    expect(classifyFile('Shell.GLB')).toBe('model');
    expect(classifyFile('shell.gltf')).toBe('other');
    expect(classifyFile('photo.jpeg')).toBe('other');
    expect(classifyFile('glb')).toBe('other');
    expect(classifyFile('')).toBe('other');
  });
});

describe('viewOf', () => {
  it('maps every store state to what the menu shows', () => {
    expect(viewOf({ status: 'none' })).toEqual({ kind: 'builtin' });
    expect(viewOf(null)).toEqual({ kind: 'builtin' });
    expect(viewOf({ status: 'loading', name: 'a.glb' })).toEqual({ kind: 'loading', name: 'a.glb' });
    expect(viewOf({ status: 'ready', name: 'a.glb', sizeBytes: 10, warnings: ['w', '', '  '] })).toEqual({ kind: 'custom', name: 'a.glb', sizeBytes: 10, warnings: ['w'] });
    expect(viewOf({ status: 'ready' })).toEqual({ kind: 'custom', name: 'model.glb', sizeBytes: null, warnings: [] });
    expect(viewOf({ status: 'error', name: 'a.glb', error: ' not a GLB ' })).toEqual({ kind: 'error', name: 'a.glb', message: 'not a GLB', warnings: [] });
  });
});

describe('optionsOf', () => {
  it('shows an explicit list as the store reports it, cleaned', () => {
    const s = new FakeStoreWithOptions().getState();
    expect(optionsOf(s)).toEqual({
      options: [
        { id: 'kode', label: 'Kode model', custom: false },
        { id: 'simple', label: 'Simple model', custom: false },
        { id: 'custom', label: 'My own…', custom: true },
      ],
      selected: 'kode',
    });
    const odd = { status: 'none', options: [{ id: 'a', label: ' A ' }, { id: 'a', label: 'again' }, { id: '', label: 'x' }, { id: 'b' }, null], selected: 'zzz' } as unknown as CustomModelState;
    expect(optionsOf(odd)).toEqual({ options: [{ id: 'a', label: 'A', custom: false }], selected: null });
  });
  it('derives Kode model, Simple model and My own from the built-in choice and the bundled file', () => {
    const ids = (s: CustomModelState) => optionsOf(s).options.map((o) => o.id);
    expect(optionsOf({ status: 'none', builtin: 'kode', bundled: 'ready' })).toEqual({
      options: [
        { id: 'kode', labelKey: 'model.option.kode', custom: false },
        { id: 'simple', labelKey: 'model.option.simple', custom: false },
        { id: 'custom', labelKey: 'model.option.own', custom: true },
      ],
      selected: 'kode',
    });
    expect(optionsOf({ status: 'none', builtin: 'simple', bundled: 'ready' }).selected).toBe('simple');
    expect(optionsOf({ status: 'none', builtin: 'kode', bundled: 'unknown' }).selected).toBe('kode');
    // the bundled file is absent or broken: the maker's model is not offered and the simple one is what is shown
    expect(ids({ status: 'none', builtin: 'kode', bundled: 'missing' })).toEqual(['simple', 'custom']);
    expect(optionsOf({ status: 'none', builtin: 'kode', bundled: 'error' }).selected).toBe('simple');
    // a user model is shown instead of either
    expect(optionsOf({ status: 'ready', name: 'a.glb', builtin: 'kode', bundled: 'ready' }).selected).toBe('custom');
    expect(optionsOf({ status: 'loading', name: 'a.glb', builtin: 'simple', bundled: 'ready' }).selected).toBe('custom');
    expect(optionsOf({ status: 'error', name: 'a.glb', builtin: 'simple', bundled: 'ready' }).selected).toBe('simple');
  });
  it('is empty for a store that reports no choices', () => {
    expect(optionsOf({ status: 'none' })).toEqual({ options: [], selected: null });
    expect(optionsOf(null)).toEqual({ options: [], selected: null });
  });
});

describe('isModelStore', () => {
  it('accepts the contract and nothing less', () => {
    expect(isModelStore(new FakeStore())).toBe(true);
    expect(isModelStore({ getState() {}, subscribe() {} })).toBe(false);
    expect(isModelStore(undefined)).toBe(false);
  });
});

describe('ModelController', () => {
  it('works without a store: built-in model, loads are refused politely', async () => {
    const c = new ModelController();
    expect(c.available).toBe(false);
    expect(c.getState()).toBe(NO_MODEL);
    expect(await c.use(glb(), 'a.glb')).toEqual({ ok: false, reason: 'unavailable' });
    await c.reset(); // no throw
  });

  it('loads a .glb, follows the store through loading to ready and tells subscribers', async () => {
    const store = new FakeStore();
    const c = new ModelController();
    c.setStore(store);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getState().status));
    expect(await c.use(glb(4096), 'shell.glb')).toEqual({ ok: true });
    expect(seen).toEqual(['loading', 'ready']);
    expect(viewOf(c.getState())).toMatchObject({ kind: 'custom', name: 'shell.glb', sizeBytes: 4096 });
    expect((viewOf(c.getState()) as { warnings: string[] }).warnings).toHaveLength(1);
  });

  it('refuses a file that is not a .glb before it reaches the store', async () => {
    const store = new FakeStore();
    const c = new ModelController();
    c.setStore(store);
    expect(await c.use(glb(), 'shell.obj')).toEqual({ ok: false, reason: 'not-glb' });
    expect(store.loads).toEqual([]);
  });

  it('reports a failed load from the store state and from a rejected promise, without throwing', async () => {
    const store = new FakeStore();
    const c = new ModelController();
    c.setStore(store);
    store.failWith = 'This file is not a binary glTF (GLB).';
    expect(await c.use(glb(), 'bad.glb')).toEqual({ ok: false, reason: 'failed', message: 'This file is not a binary glTF (GLB).' });
    expect(viewOf(c.getState())).toMatchObject({ kind: 'error', name: 'bad.glb' });
    store.failWith = null;
    store.throwOnLoad = true;
    expect(await c.use(glb(), 'worse.glb')).toEqual({ ok: false, reason: 'failed', message: 'boom' });
  });

  it('goes back to the built-in model', async () => {
    const store = new FakeStore();
    const c = new ModelController();
    c.setStore(store);
    await c.use(glb(), 'shell.glb');
    await c.reset();
    expect(viewOf(c.getState())).toEqual({ kind: 'builtin' });
  });

  it('switches between the options a store reports, and says no when it cannot', async () => {
    const store = new FakeStoreWithOptions();
    const c = new ModelController();
    c.setStore(store);
    expect(await c.choose('simple')).toBe(true);
    expect(optionsOf(c.getState()).selected).toBe('simple');
    expect(await c.choose('broken')).toBe(false);
    expect(optionsOf(c.getState()).selected).toBe('simple');
    const plain = new ModelController();
    plain.setStore(new FakeStore());
    expect(await plain.choose('kode')).toBe(false); // a store with neither select() nor setBuiltin()
    expect(await new ModelController().choose('kode')).toBe(false); // no store at all
  });

  it('with the built-in choice: picks Kode or Simple, and takes the user model away first', async () => {
    const store = new FakeKodeStore();
    const c = new ModelController();
    c.setStore(store);
    expect(await c.choose('simple')).toBe(true);
    expect(optionsOf(c.getState()).selected).toBe('simple');
    expect(store.removed).toBe(0);
    await c.use(glb(), 'shell.glb');
    expect(optionsOf(c.getState()).selected).toBe('custom');
    expect(await c.choose('kode')).toBe(true);
    expect(store.removed).toBe(1);
    expect(optionsOf(c.getState())).toMatchObject({ selected: 'kode' });
    expect(await c.choose('custom')).toBe(false); // "my own" is chosen by loading a file, not by an id
  });

  it('passes the performance switch on', async () => {
    const store = new FakeKodeStore();
    const c = new ModelController();
    c.setStore(store);
    await c.setPerformance(false);
    expect(c.getState().performance).toBe(false);
    await new ModelController().setPerformance(true); // no store: no throw
  });

  it('keeps the same snapshot object while nothing changed and stops listening to a replaced store', () => {
    const a = new FakeStore();
    const c = new ModelController();
    c.setStore(a);
    a.set({ status: 'ready', name: 'a.glb' });
    const snap = c.getState();
    a.set({ status: 'ready', name: 'a.glb' });
    expect(c.getState()).toBe(snap);
    const b = new FakeStore();
    c.setStore(b);
    expect(a.listeners.size).toBe(0);
    expect(viewOf(c.getState())).toEqual({ kind: 'builtin' });
  });
});
