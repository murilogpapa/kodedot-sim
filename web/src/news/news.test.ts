import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../i18n/core';
import { parseGuideHash, isSectionId } from '../guide/route';
import { CHANGELOG, LATEST_NOTE_ID, NOTES, autoEntry, mergeChangelog, type NewsEntry } from './changelog';
import { EARLIER_MAX, NewsStore, SEEN_KEY, WELCOMED_KEY, mayAppear, planNews } from './store';
import { NEWS_STRINGS, entryDate } from './strings';

const entry = (id: string): NewsEntry => ({ id, title: { en: `t ${id}`, 'pt-BR': `t ${id}`, es: `t ${id}`, fr: `t ${id}` }, points: { en: ['a', 'b', 'c'], 'pt-BR': ['a', 'b', 'c'], es: ['a', 'b', 'c'], fr: ['a', 'b', 'c'] } });
const E = (...ids: string[]) => ids.map(entry);

/** A localStorage stand-in. */
function storage(init: Record<string, unknown> = {}) {
  const m = new Map<string, string>(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), read: (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : undefined) };
}

describe('the changelog data', () => {
  it('has the placeholder entry first, under the constant id', () => {
    expect(NOTES[0].id).toBe(LATEST_NOTE_ID);
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });
  it('is newest first with unique date-based ids', () => {
    const ids = CHANGELOG.map((e) => e.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}(-[a-z0-9.-]+)?$/);
  });
  it('gives every hand-written entry a title and the same 3 to 6 points in every language', () => {
    for (const e of NOTES) {
      const n = e.points.en.length;
      expect(n, e.id).toBeGreaterThanOrEqual(3);
      expect(n, e.id).toBeLessThanOrEqual(6);
      for (const { id } of LOCALES) {
        expect(e.title[id].trim(), `${e.id} ${id}`).not.toBe('');
        expect(e.points[id].length, `${e.id} ${id}`).toBe(n);
        for (const p of e.points[id]) expect(p.trim(), `${e.id} ${id}`).not.toBe('');
      }
      if (e.guide) expect(isSectionId(e.guide)).toBe(true);
    }
  });
  it('has the card labels in every language, and no em dash anywhere', () => {
    for (const { id } of LOCALES) for (const v of Object.values(NEWS_STRINGS[id])) expect(v.trim()).not.toBe('');
    expect(JSON.stringify([CHANGELOG, NEWS_STRINGS, autoEntry({ id: '2026-12-03-kodeos-0.1.3', kind: 'kodeos', version: 'v0.1.3' })])).not.toContain('—');
  });
  it('merges the automatic kodeOS lines, newest first, and ignores a malformed line', () => {
    const merged = mergeChangelog(E('2026-11-18'), [{ id: '2026-12-03-kodeos-0.1.3', kind: 'kodeos', version: 'v0.1.3' }, { id: 'x', kind: 'kodeos', version: 'v1' }, null, 'junk', { id: '2026-11-18-kodeos-0.1.2', kind: 'kodeos', version: 'v0.1.2' }]);
    expect(merged.map((e) => e.id)).toEqual(['2026-12-03-kodeos-0.1.3', '2026-11-18-kodeos-0.1.2', '2026-11-18']);
    expect(merged[0].title).toEqual({ en: 'kodeOS updated to v0.1.3', 'pt-BR': 'kodeOS atualizado para v0.1.3', es: 'kodeOS actualizado a v0.1.3', fr: 'kodeOS mis à jour vers v0.1.3' });
    for (const { id } of LOCALES) expect(merged[0].points[id].length).toBe(2);
  });
  it('reads the day of an entry from its id', () => {
    expect(entryDate('2026-11-18', 'en')).toBe('Nov 18, 2026');
    expect(entryDate('2026-12-03-kodeos-0.1.3', 'pt-BR')).toMatch(/3 de dez\.? de 2026/);
    expect(entryDate('nonsense', 'en')).toBe('');
  });
});

describe('when the card shows', () => {
  it('shows the newest entry to a returning visitor with an older seen id', () => {
    const p = planNews(E('2026-12-01', '2026-11-18'), { welcomed: true, seen: '2026-11-18' });
    expect(p.show?.id).toBe('2026-12-01');
    expect(p.earlier).toEqual([]);
    expect(p.markSeen).toBeNull();
  });
  it('shows the newest entry alone to someone who visited before the card existed', () => {
    const p = planNews(E('2026-12-01', '2026-11-18'), { welcomed: true, seen: null });
    expect(p.show?.id).toBe('2026-12-01');
    expect(p.earlier).toEqual([]);
  });
  it('does not show to a first-time visitor, and records the newest id for their next visit', () => {
    const s = storage();
    const first = new NewsStore(s, E('2026-12-01', '2026-11-18'));
    expect(first.get()).toBeNull();
    expect(s.read(SEEN_KEY)).toBe('2026-12-01');
    s.setItem(WELCOMED_KEY, 'true'); // they dismiss the welcome
    expect(new NewsStore(s, E('2026-12-01', '2026-11-18')).get()).toBeNull();
  });
  it('does not show again after it was dismissed', () => {
    const s = storage({ [WELCOMED_KEY]: true, [SEEN_KEY]: '2026-11-18' });
    const store = new NewsStore(s, E('2026-12-01', '2026-11-18'));
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get()).toMatchObject({ manual: false, entry: { id: '2026-12-01' } });
    expect(s.read(SEEN_KEY)).toBe('2026-11-18'); // not recorded until the visitor closes it
    store.dismiss();
    expect(store.get()).toBeNull();
    expect(calls).toBe(1);
    expect(s.read(SEEN_KEY)).toBe('2026-12-01');
    expect(new NewsStore(s, E('2026-12-01', '2026-11-18')).get()).toBeNull();
  });
  it('shows again once a newer entry exists', () => {
    const s = storage({ [WELCOMED_KEY]: true, [SEEN_KEY]: '2026-12-01' });
    expect(new NewsStore(s, E('2026-12-01', '2026-11-18')).get()).toBeNull();
    const later = new NewsStore(s, E('2026-12-09-kodeos-0.1.3', '2026-12-01', '2026-11-18'));
    expect(later.get()?.entry.id).toBe('2026-12-09-kodeos-0.1.3');
    later.dismiss();
    expect(new NewsStore(s, E('2026-12-09-kodeos-0.1.3', '2026-12-01', '2026-11-18')).get()).toBeNull();
  });
  it('lists the other missed entries by title, newest first, at most three', () => {
    const all = E('2026-12-20', '2026-12-15', '2026-12-10', '2026-12-05', '2026-12-01', '2026-11-18');
    const p = planNews(all, { welcomed: true, seen: '2026-11-18' });
    expect(p.show?.id).toBe('2026-12-20');
    expect(p.earlier.map((e) => e.id)).toEqual(['2026-12-15', '2026-12-10', '2026-12-05']);
    expect(p.earlier.length).toBe(EARLIER_MAX);
    // two missed: one in the list, and never one already seen
    expect(planNews(all, { welcomed: true, seen: '2026-12-10' }).earlier.map((e) => e.id)).toEqual(['2026-12-15']);
  });
  it('waits for a settled page and stays off the guide when the visitor arrived through a #guide link', () => {
    const s = storage({ [WELCOMED_KEY]: true, [SEEN_KEY]: '2026-11-18' });
    const store = new NewsStore(s, E('2026-12-01', '2026-11-18'));
    expect(store.get()).not.toBeNull(); // it is due...
    expect(mayAppear({ settled: true, guideOpen: parseGuideHash('#guide/bench').open })).toBe(false); // ...but not over the guide
    expect(s.read(SEEN_KEY)).toBe('2026-11-18'); // and it is not counted as seen
    expect(mayAppear({ settled: false, guideOpen: false })).toBe(false); // nor over the loading state
    expect(mayAppear({ settled: true, guideOpen: false, layersOpen: 1 })).toBe(false); // nor over an open menu
    expect(mayAppear({ settled: true, guideOpen: parseGuideHash('').open })).toBe(true); // once the guide is closed
  });
  it('reopens the latest notes on demand, and closing them keeps the card away', () => {
    const s = storage({ [WELCOMED_KEY]: true, [SEEN_KEY]: '2026-12-01' });
    const store = new NewsStore(s, E('2026-12-01', '2026-11-18'));
    expect(store.get()).toBeNull();
    expect(store.hasNotes).toBe(true);
    store.open();
    expect(store.get()).toMatchObject({ manual: true, entry: { id: '2026-12-01' } });
    expect(store.get()?.earlier.map((e) => e.id)).toEqual(['2026-11-18']);
    store.dismiss();
    expect(store.get()).toBeNull();
    expect(new NewsStore(storage(), []).hasNotes).toBe(false);
  });
  it('works without storage (private mode)', () => {
    const store = new NewsStore(null, E('2026-12-01'));
    expect(store.get()).toBeNull(); // nothing says they were here before
    store.open();
    store.dismiss();
    expect(store.get()).toBeNull();
  });
});

describe('tools/news-add.mjs (what the kodeOS updater calls)', () => {
  const tool = resolve(__dirname, '../../../tools/news-add.mjs');
  const run = (...a: string[]) => execFileSync(process.execPath, [tool, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  it('appends a line the changelog accepts, once, and leaves the file alone on a dry run or bad input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'news-'));
    try {
      const file = join(dir, 'auto.json');
      writeFileSync(file, '[]\n');
      run('kodeos', 'v0.1.3', '--date', '2026-12-03', '--file', file, '--dry-run');
      expect(readFileSync(file, 'utf8')).toBe('[]\n');
      run('kodeos', 'v0.1.3', '--date', '2026-12-03', '--file', file);
      run('kodeos', 'v0.1.3', '--date', '2026-12-04', '--file', file); // the same release again: nothing
      run('kodeos', 'v0.2.0', '--date', '2026-12-20', '--file', file);
      const list = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
      expect(list).toEqual([
        { id: '2026-12-20-kodeos-0.2.0', kind: 'kodeos', version: 'v0.2.0' },
        { id: '2026-12-03-kodeos-0.1.3', kind: 'kodeos', version: 'v0.1.3' },
      ]);
      expect(mergeChangelog(E('2026-11-18'), list).map((e) => e.id)).toEqual(['2026-12-20-kodeos-0.2.0', '2026-12-03-kodeos-0.1.3', '2026-11-18']);
      expect(() => run('kodeos', '0.3', '--file', file)).toThrow();
      expect(() => run('kodeos', 'v0.3.0', '--date', 'tomorrow', '--file', file)).toThrow();
      expect((JSON.parse(readFileSync(file, 'utf8')) as unknown[]).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the committed auto.json is a list the changelog accepts whole', () => {
    const list = JSON.parse(readFileSync(resolve(__dirname, 'auto.json'), 'utf8')) as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(mergeChangelog([], list).length).toBe(list.length);
  });
});
