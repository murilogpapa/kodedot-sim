import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en as site } from '../i18n/en';
import { translate } from '../i18n/core';
import { APP_PACKAGE_EXT } from '../lib/appPackage';
import { BUNDLED_APPS } from './apps';
import { CAPABILITIES } from './capabilities';
import { GUIDE_DICTS, ISSUES_URL, REPO_URL, UI_LABEL, guideText, type GuideKey } from './content';
import { en } from './content.en';
import { linksOf, parseInline } from './inline';
import { SECTION_IDS, guideHash, isSectionId, parseGuideHash } from './route';
import { SECTIONS, type Block } from './sections';
import { BOARD_NAMES, SKETCH_BOARD_IDS, SKETCH_FAMILIES, SKETCH_SUPPORTED, SKETCH_UNSUPPORTED, fingerprint, sketchText } from './sketchData';
import { SKETCH_TEXTS } from './sketchData.i18n';

const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const LANGS = ['en', 'pt-BR', 'es', 'fr'] as const;
const OTHERS = ['pt-BR', 'es', 'fr'] as const;
const KEYS = Object.keys(en) as GuideKey[];

const varsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const labelsOf = (s: string) => [...s.matchAll(UI_LABEL)].map((m) => m[1]).sort();
const keysOf = (s: string) => [...s.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]).sort();

/** Every text key a block shows. */
function blockKeys(b: Block): GuideKey[] {
  switch (b.t) {
    case 'p':
    case 'h':
    case 'note':
      return [b.k];
    case 'list':
      return [...b.k];
    case 'steps':
      return b.k.map((s) => (typeof s === 'string' ? s : s.k));
    case 'fig':
      return [b.cap];
    case 'keys':
      return ['dot.key.top', 'dot.key.bottom', 'dot.key.dpad', 'dot.key.screen', 'dot.key.screen.how'];
    case 'apps':
      return ['ui.source', ...BUNDLED_APPS.flatMap((a) => [a.text, a.source.label])];
    case 'boards':
      return SKETCH_FAMILIES.map((f) => `sk.family.${f.family}` as GuideKey);
    case 'support':
      return ['sk.yes.h', 'sk.no.h', 'sk.notes.h'];
    case 'capabilities':
      return ['sim.status.works', 'sim.status.partial', 'sim.status.none', 'sim.col.area', 'sim.col.state', 'sim.col.detail', ...CAPABILITIES.flatMap((c) => [c.area, c.detail])];
    case 'code':
      return [];
  }
}

describe('guide sections', () => {
  it('every section id has exactly one section, in the order of the ids', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([...SECTION_IDS]);
  });
  it('every section has a title and something to read', () => {
    for (const s of SECTIONS) {
      expect(en[s.title], s.id).toBeTruthy();
      expect(s.blocks.length, s.id).toBeGreaterThan(1);
    }
  });
  it('every text a section shows exists, and no text is left unused', () => {
    const used = new Set<string>(KEYS.filter((k) => k.startsWith('ui.')));
    for (const s of SECTIONS) {
      used.add(s.title);
      for (const b of s.blocks) for (const k of blockKeys(b)) used.add(k);
    }
    expect([...used].filter((k) => !(k in en)), 'shown but not written').toEqual([]);
    expect(KEYS.filter((k) => !used.has(k)), 'written but never shown').toEqual([]);
  });
  it('every link to a section resolves, in every language', () => {
    const bad: string[] = [];
    for (const lang of LANGS) {
      for (const k of KEYS) {
        for (const target of linksOf(GUIDE_DICTS[lang][k])) {
          if (target.startsWith('#') && !isSectionId(target.slice(1))) bad.push(`${lang} ${k}: ${target}`);
          if (!target.startsWith('#') && !/^(https:\/\/|\{(repo|issues|site)\})/.test(target)) bad.push(`${lang} ${k}: ${target}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('guide languages', () => {
  for (const lang of OTHERS) {
    const dict = GUIDE_DICTS[lang] as Record<string, string>;
    it(`${lang} has exactly the keys of en, none empty`, () => {
      const keys = Object.keys(dict);
      expect(keys.filter((k) => !(k in en)), 'extra').toEqual([]);
      expect(KEYS.filter((k) => !keys.includes(k)), 'missing').toEqual([]);
      expect(keys.filter((k) => !dict[k].trim()), 'empty').toEqual([]);
    });
    it(`${lang} names the same variables, page labels, keys and links as en in every text`, () => {
      const bad: string[] = [];
      for (const k of KEYS) {
        const a = en[k];
        const b = dict[k];
        const same = (f: (s: string) => string[], what: string) => {
          if (JSON.stringify(f(a)) !== JSON.stringify(f(b))) bad.push(`${k}: ${what} en ${JSON.stringify(f(a))} vs ${lang} ${JSON.stringify(f(b))}`);
        };
        same(varsOf, 'variables');
        same(labelsOf, 'page labels');
        same(keysOf, 'keys');
        same((s) => linksOf(s).sort(), 'links');
      }
      expect(bad).toEqual([]);
    });
    it(`${lang} is written, not copied: its sentences differ from the English ones`, () => {
      const prose = KEYS.filter((k) => en[k].split(' ').length >= 6);
      expect(prose.filter((k) => dict[k] === en[k])).toEqual([]);
    });
  }
  it('every page label a text names is a text of the page', () => {
    const missing: string[] = [];
    for (const k of KEYS) for (const label of labelsOf(en[k])) if (!(label in site)) missing.push(`${k}: ${label}`);
    expect(missing).toEqual([]);
  });
  it('page labels and variables are filled in when a text is shown', () => {
    for (const lang of LANGS) {
      for (const k of KEYS) expect(guideText(lang, k), `${lang} ${k}`).not.toMatch(/\{[\w:.-]+\}/);
    }
    expect(guideText('pt-BR', 'start.s4')).toContain(translate('pt-BR', 'kind.nfc.tag'));
    expect(guideText('es', 'help.bug')).toContain(ISSUES_URL);
    expect(guideText('en', 'help.source')).toContain(REPO_URL);
  });
  it('the app package is named by its one constant, never typed out', () => {
    const typed: string[] = [];
    for (const lang of LANGS) for (const k of KEYS) if (/\.(dotbench(?!-env)|zip)\b/i.test(GUIDE_DICTS[lang][k].replace(/\ba zip\b/g, ''))) typed.push(`${lang} ${k}`);
    expect(typed).toEqual([]);
    for (const lang of LANGS) expect(guideText(lang, 'app.what')).toContain(APP_PACKAGE_EXT);
  });
});

describe('guide links', () => {
  it('a section link is #guide/<id> and reads back', () => {
    for (const id of SECTION_IDS) {
      expect(guideHash(id)).toBe(`#guide/${id}`);
      expect(parseGuideHash(guideHash(id))).toEqual({ open: true, section: id });
    }
  });
  it('#guide alone, an unknown section and an old name all open something sensible', () => {
    expect(parseGuideHash('#guide')).toEqual({ open: true, section: 'start' });
    expect(parseGuideHash('#guide/')).toEqual({ open: true, section: 'start' });
    expect(parseGuideHash('#guide/nope')).toEqual({ open: true, section: 'start' });
    expect(parseGuideHash('#guide/Your-Own-App')).toEqual({ open: true, section: 'your-own-app' });
    expect(parseGuideHash('#guide/faq')).toEqual({ open: true, section: 'help' });
    expect(parseGuideHash('#guide/%E0%A4%A')).toEqual({ open: true, section: 'start' });
  });
  it('anything else is not the guide', () => {
    for (const h of ['', '#', '#device', '#guides', '#guide-x/start']) expect(parseGuideHash(h).open, h).toBe(false);
  });
});

describe('inline marks', () => {
  it('reads bold, code, keys, section links and outside links', () => {
    expect(parseInline('Press [[W]] or **Wire**, then `x` and [here](#bench) or [there](https://example.com/a).')).toEqual([
      { t: 'text', s: 'Press ' },
      { t: 'key', s: 'W' },
      { t: 'text', s: ' or ' },
      { t: 'bold', s: 'Wire' },
      { t: 'text', s: ', then ' },
      { t: 'code', s: 'x' },
      { t: 'text', s: ' and ' },
      { t: 'section', s: 'here', to: 'bench' },
      { t: 'text', s: ' or ' },
      { t: 'link', s: 'there', href: 'https://example.com/a' },
      { t: 'text', s: '.' },
    ]);
  });
  it('a link to a section that does not exist is shown as plain text', () => {
    expect(parseInline('[x](#nope)')).toEqual([{ t: 'text', s: 'x' }]);
  });
  it('no text of the guide is left with marks it cannot read', () => {
    const odd: string[] = [];
    for (const lang of LANGS) {
      for (const k of KEYS) {
        const plain = parseInline(guideText(lang, k))
          .filter((p) => p.t === 'text')
          .map((p) => p.s)
          .join('');
        if (/\*\*|\[\[|\]\]|\]\(|`/.test(plain)) odd.push(`${lang} ${k}`);
      }
    }
    expect(odd).toEqual([]);
  });
});

describe('the bundled apps', () => {
  const factory = JSON.parse(readFileSync(new URL('../../scripts/factory-apps.json', import.meta.url), 'utf8')) as { os: string; factory: string[] };
  const sources = readFileSync(new URL('../../public/apps/SOURCES.md', import.meta.url), 'utf8');
  it('are the system and the factory set, in kodeOS\'s order', () => {
    expect(BUNDLED_APPS.map((a) => a.id)).toEqual([factory.os, ...factory.factory]);
  });
  it('each one is named and sourced as SOURCES.md records it', () => {
    for (const a of BUNDLED_APPS) {
      expect(sources, a.name).toContain(a.name);
      if (a.source.label === 'apps.src.kode') expect(sources, a.id).toContain(a.source.url);
      else {
        expect(a.source.url).toBe(`${REPO_URL}/tree/main/apps/${a.id}`);
        expect(existsSync(repo(`apps/${a.id}`)), a.id).toBe(true);
      }
    }
  });
});

describe('the compiler\'s support lists', () => {
  it('every board the compiler has is named, and has a family title', () => {
    expect(Object.keys(BOARD_NAMES).sort()).toEqual([...SKETCH_BOARD_IDS].sort());
    for (const f of SKETCH_FAMILIES) expect(`sk.family.${f.family}` in en, f.family).toBe(true);
  });
  it('the lists are the compiler\'s own, not empty', () => {
    expect(SKETCH_SUPPORTED.length).toBeGreaterThan(2);
    expect(SKETCH_UNSUPPORTED.length).toBeGreaterThan(2);
  });
  it('every translated sentence was written for the sentence the compiler states today', () => {
    const items = [...SKETCH_SUPPORTED, ...SKETCH_UNSUPPORTED, ...SKETCH_FAMILIES.flatMap((f) => f.notes)];
    const ids = items.map((x) => x.id).sort();
    for (const lang of OTHERS) {
      const texts = SKETCH_TEXTS[lang];
      expect(Object.keys(texts).sort(), `${lang}: one translation per sentence`).toEqual(ids);
      // when this fails: the compiler's sentence changed. Rewrite the translation, then put the new fingerprint in `of`.
      const stale = items.filter((x) => texts[x.id].of !== fingerprint(x.source)).map((x) => `${lang} ${x.id}: now ${fingerprint(x.source)}`);
      expect(stale).toEqual([]);
      for (const x of items) expect(sketchText(x, lang)).toBe(texts[x.id].text);
    }
    for (const x of items) expect(sketchText(x, 'en')).toBe(x.source);
  });
  it('a sentence the compiler changed falls back to the compiler\'s English', () => {
    const item = { id: SKETCH_SUPPORTED[0].id, source: `${SKETCH_SUPPORTED[0].source} And more.` };
    expect(sketchText(item, 'pt-BR')).toBe(item.source);
  });
});

describe('the capability table', () => {
  it('has one row per area, each written from status files that exist', () => {
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length);
    for (const c of CAPABILITIES) {
      expect(c.area in en && c.detail in en, c.id).toBe(true);
      expect(c.from.length, c.id).toBeGreaterThan(0);
      for (const f of c.from) expect(existsSync(repo(`docs/STATUS-${f}.md`)), `${c.id}: docs/STATUS-${f}.md`).toBe(true);
    }
  });
  it('says what the status files say about the pieces that are easy to oversell', () => {
    const state = (id: string) => CAPABILITIES.find((c) => c.id === id)?.state;
    expect(state('ble')).toBe('partial');
    expect(state('usb')).toBe('partial');
    expect(state('wifi')).toBe('partial');
    expect(state('audio')).toBe('partial');
    expect(state('shape')).toBe('none');
    expect(state('camera')).toBe('none');
  });
});

describe('names the worked examples take from the parts library', () => {
  const lib = JSON.parse(readFileSync(repo('parts/prebuilt/library.json'), 'utf8')) as { parts: { id: string; name: Record<string, string> }[] };
  const nameOf = (id: string, lang: string) => lib.parts.find((p) => p.id === id)!.name[lang];
  const fieldLabel = (part: string, field: string, lang: string) => {
    const m = JSON.parse(readFileSync(repo(`parts/${part}/manifest.json`), 'utf8')) as { fields: { name: string; label: Record<string, string> }[] };
    return m.fields.find((f) => f.name === field)!.label[lang];
  };
  for (const lang of LANGS) {
    it(`${lang}: the parts and their fields are called what the library calls them`, () => {
      for (const id of ['dotbench.breadboard-half', 'dotbench.led-red', 'dotbench.resistor']) expect(GUIDE_DICTS[lang]['wb.ex1.1'], id).toContain(`**${nameOf(id, lang)}**`);
      expect(GUIDE_DICTS[lang]['wb.ex1.2']).toContain(`**${fieldLabel('resistor', 'ohms', lang)}**`);
      expect(GUIDE_DICTS[lang]['wb.ex2.1']).toContain(`**${nameOf('dotbench.uno-r3', lang)}**`);
      expect(GUIDE_DICTS[lang]['wb.ex2.1']).toContain(`**${fieldLabel('uno-r3', 'usb', lang)}**`);
    });
  }
});
