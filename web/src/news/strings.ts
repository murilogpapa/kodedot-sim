import type { Locale } from '../i18n/core';

/** The card's own labels, kept here (not in the shared dictionaries) so this feature is one folder. */
export interface NewsStrings {
  label: string;
  gotIt: string;
  close: string;
  earlier: string;
  more: string;
}

export const NEWS_STRINGS: Record<Locale, NewsStrings> = {
  en: { label: "What's new", gotIt: 'Got it', close: 'Close', earlier: 'Also earlier', more: 'Show me in the guide' },
  'pt-BR': { label: 'Novidades', gotIt: 'Entendi', close: 'Fechar', earlier: 'Também teve antes', more: 'Ver no guia' },
  es: { label: 'Novedades', gotIt: 'Entendido', close: 'Cerrar', earlier: 'También antes', more: 'Ver en la guía' },
  fr: { label: 'Nouveautés', gotIt: 'Compris', close: 'Fermer', earlier: 'Aussi avant', more: 'Voir dans le guide' },
};

/** The day an entry was published, from its id ("2026-11-18-kodeos-0.1.3" -> 18 Nov 2026 in the visitor's language). */
export function entryDate(id: string, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(id);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}
