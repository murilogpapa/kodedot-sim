import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { ptBR } from './pt-BR';

export type Locale = 'en' | 'pt-BR' | 'es' | 'fr';
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
];

/** `en` is the source of truth: its keys define MessageKey. Other locales are typed Messages, so a missing or extra key is a compile error. */
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

type PluralSuffix = 'one' | 'other';
/** Keys callable with t(): plain keys, and the base of `x.one` / `x.other` pairs (selected by vars.count). */
export type TKey = Exclude<MessageKey, `${string}.${PluralSuffix}`> | (MessageKey extends infer K ? (K extends `${infer B}.${PluralSuffix}` ? B : never) : never);

export type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

export const DICTS: Record<Locale, Messages> = { en, 'pt-BR': ptBR, es, fr };

export function detectLocale(languages: readonly string[]): Locale {
  for (const l of languages) {
    const low = l.toLowerCase();
    if (low.startsWith('pt')) return 'pt-BR';
    if (low.startsWith('es')) return 'es';
    if (low.startsWith('fr')) return 'fr';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

export function isLocale(x: unknown): x is Locale {
  return x === 'en' || x === 'pt-BR' || x === 'es' || x === 'fr';
}

export function interpolate(tpl: string, vars: Vars | undefined, locale: Locale): string {
  if (!vars) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    if (v === undefined) return m;
    return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : v;
  });
}

export function translate(locale: Locale, key: TKey, vars?: Vars): string {
  const dict = DICTS[locale] as Record<string, string>;
  const base = en as Record<string, string>;
  let tpl: string | undefined;
  if (vars && typeof vars.count === 'number') {
    const rule = new Intl.PluralRules(locale).select(vars.count);
    tpl = dict[`${key}.${rule}`] ?? dict[`${key}.other`] ?? base[`${key}.${rule}`] ?? base[`${key}.other`];
  }
  tpl ??= dict[key] ?? base[key] ?? key;
  return interpolate(tpl, vars, locale);
}

export function makeFormatters(locale: Locale) {
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'medium' });
  // log lines: a fixed-width 24-hour clock in every language, so the column stays narrow and aligned
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const full = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' });
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const num2 = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return {
    dateTime: (ms: number) => dateTime.format(ms),
    time: (ms: number) => time.format(ms),
    clock: (ms: number) => clock.format(ms),
    dateTimeFull: (ms: number) => full.format(ms),
    number: (n: number) => new Intl.NumberFormat(locale).format(n),
    bytes: (n: number) => {
      if (n < 1024) return `${new Intl.NumberFormat(locale).format(n)} B`;
      if (n < 1024 * 1024) return `${num.format(n / 1024)} KB`;
      if (n < 1024 * 1024 * 1024) return `${num2.format(n / 1024 / 1024)} MB`;
      return `${num2.format(n / 1024 / 1024 / 1024)} GB`;
    },
  };
}
export type Formatters = ReturnType<typeof makeFormatters>;
