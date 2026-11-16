import { describe, expect, it } from 'vitest';
import { DICTS, detectLocale, interpolate, translate, type Locale } from './core';
import { en } from './en';

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const locales = Object.keys(DICTS) as Locale[];

describe('locale dictionaries', () => {
  for (const loc of locales.filter((l) => l !== 'en')) {
    it(`${loc} has exactly the keys of en`, () => {
      const base = Object.keys(en).sort();
      const keys = Object.keys(DICTS[loc]).sort();
      expect(keys.filter((k) => !base.includes(k)), 'extra keys').toEqual([]);
      expect(base.filter((k) => !keys.includes(k)), 'missing keys').toEqual([]);
    });
    it(`${loc} uses the same interpolation variables as en for every key`, () => {
      const bad: string[] = [];
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        const a = JSON.stringify(vars(en[k]));
        const b = JSON.stringify(vars((DICTS[loc] as Record<string, string>)[k]));
        if (a !== b) bad.push(`${k}: en ${a} vs ${loc} ${b}`);
      }
      expect(bad).toEqual([]);
    });
    it(`${loc} has no empty strings`, () => {
      expect(Object.entries(DICTS[loc]).filter(([, v]) => !v.trim())).toEqual([]);
    });
  }
  it('plural keys come in one/other pairs', () => {
    for (const loc of locales) {
      const keys = Object.keys(DICTS[loc]);
      for (const k of keys.filter((x) => x.endsWith('.one'))) expect(keys).toContain(k.replace(/\.one$/, '.other'));
    }
  });
});

describe('detectLocale', () => {
  it('maps navigator languages', () => {
    expect(detectLocale(['pt-BR', 'en'])).toBe('pt-BR');
    expect(detectLocale(['pt-PT'])).toBe('pt-BR');
    expect(detectLocale(['es-MX'])).toBe('es');
    expect(detectLocale(['fr', 'es'])).toBe('es');
    expect(detectLocale(['de'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});

describe('translate', () => {
  it('interpolates and picks plurals', () => {
    expect(translate('en', 'apps.count', { count: 1 })).toContain('1 saved app,');
    expect(translate('en', 'apps.count', { count: 3 })).toContain('3 saved apps');
    expect(translate('pt-BR', 'apps.count', { count: 0 })).toContain('0 app salvo');
    expect(translate('pt-BR', 'apps.count', { count: 2 })).toContain('apps salvos');
    expect(translate('es', 'apps.run', { name: 'x.dotbench' })).toBe('Ejecutar x.dotbench');
  });
  it('formats numbers with the locale and leaves unknown placeholders alone', () => {
    expect(interpolate('{n} and {x}', { n: 1234.5 }, 'pt-BR')).toBe('1.234,5 and {x}');
  });

  it('counts new console lines with the right plural in every language', () => {
    expect(translate('en', 'console.paused', { count: 1 })).toBe('1 new line');
    expect(translate('en', 'console.paused', { count: 12 })).toBe('12 new lines');
    expect(translate('pt-BR', 'console.paused', { count: 1 })).toBe('1 linha nova');
    expect(translate('pt-BR', 'console.paused', { count: 3 })).toBe('3 linhas novas');
    expect(translate('es', 'console.paused', { count: 1 })).toBe('1 línea nueva');
    expect(translate('es', 'console.paused', { count: 15000 })).toBe('15.000 líneas nuevas'); // numbers follow the language
  });
  it('names the product descriptor in each language', () => {
    expect(translate('en', 'app.descriptor')).toBe('A simulator for Kode Dot apps');
    expect(translate('pt-BR', 'app.descriptor')).toBe('Simulador de apps do Kode Dot');
    expect(translate('es', 'app.descriptor')).toBe('Simulador de apps para Kode Dot');
  });
});
