/**
 * What changed on the site, newest first: the data behind the "What's new" card (WhatsNew.tsx).
 *
 * To announce an update: add one entry at the TOP of NOTES with a new id. The id is the publication date
 * (YYYY-MM-DD, plus a suffix such as "-b" for a second one on the same day); ids are compared as text, so a later
 * date is a newer entry. Give it a short title and 3 to 6 short points in the three languages (the types refuse an
 * entry that lacks a language; news.test.ts checks the counts). `guide` is optional: a section of the guide the card
 * links to. Returning visitors see the card once, the first time they open the site after the entry is published.
 *
 * The kodeOS updater does not edit this file: tools/news-add.mjs appends a line to auto.json, and the entry's texts
 * are made here from that line (autoEntry).
 */
import type { Locale } from '../i18n/core';
import type { SectionId } from '../guide/route';
import auto from './auto.json';

export type Localised<T> = Record<Locale, T>;

export interface NewsEntry {
  /** Date based, unique, compared as text: "2026-11-18", "2026-11-18-b", "2026-12-03-kodeos-0.1.3". */
  id: string;
  title: Localised<string>;
  /** 3 to 6 short points (the automatic kodeOS entries have 2). */
  points: Localised<string[]>;
  /** A section of the guide that tells more (#guide/<section>). */
  guide?: SectionId;
}

/** A line of auto.json, written by tools/news-add.mjs when the updater moves to a new kodeOS release. */
export interface AutoNote {
  id: string;
  kind: 'kodeos';
  /** The release tag, "v0.1.3". */
  version: string;
}

/** The id of the newest hand-written entry: change it to the day the update is published. */
export const LATEST_NOTE_ID = '2026-11-19';

/** Hand-written entries, newest first. */
export const NOTES: NewsEntry[] = [
  {
    id: LATEST_NOTE_ID,
    title: {
      en: 'KodeCity is on the Dot',
      'pt-BR': 'KodeCity já vem no Dot',
      es: 'KodeCity ya viene en el Dot',
      fr: 'KodeCity est sur le Dot',
    },
    points: {
      en: [
        'KodeCity, an open-world 3D city to drive and walk around, is now installed with the other apps.',
        'Open it from the Apps menu and steer with the D-pad.',
        'KodeCity is Kode\'s open-source game, built here from its public repository.',
      ],
      'pt-BR': [
        'KodeCity, uma cidade 3D de mundo aberto para dirigir e andar, já vem instalada com os outros apps.',
        'Abra pelo menu Apps e controle com o direcional.',
        'KodeCity é o jogo de código aberto da Kode, compilado aqui a partir do repositório público.',
      ],
      es: [
        'KodeCity, una ciudad 3D de mundo abierto para conducir y pasear, ya viene instalada con las demás apps.',
        'Ábrela desde el menú Apps y muévete con la cruceta.',
        'KodeCity es el juego de código abierto de Kode, compilado aquí desde su repositorio público.',
      ],
      fr: [
        'KodeCity, une ville 3D en monde ouvert où conduire et se promener, est maintenant installée avec les autres apps.',
        'Ouvrez-la depuis le menu Apps et dirigez-vous avec la croix directionnelle.',
        'KodeCity est le jeu open source de Kode, compilé ici à partir de son dépôt public.',
      ],
    },
  },
  {
    id: '2026-11-18-b',
    title: {
      en: 'Export your project as a PDF',
      'pt-BR': 'Exporte seu projeto em PDF',
      es: 'Exporta tu proyecto en PDF',
      fr: 'Exportez votre projet en PDF',
    },
    points: {
      en: [
        'One file with a picture of the table, the schematic, every connection to tick off, the parts list and the code.',
        'Open that same PDF here again and the whole bench comes back as it was.',
        'Find it in the Bench panel, under Bench file.',
      ],
      'pt-BR': [
        'Um arquivo com a foto da mesa, o esquemático, cada ligação para marcar, a lista de peças e o código.',
        'Abra esse mesmo PDF aqui de novo e a bancada inteira volta como estava.',
        'Fica no painel Bancada, em Arquivo da bancada.',
      ],
      es: [
        'Un archivo con una foto de la mesa, el esquema, cada conexión para marcar, la lista de piezas y el código.',
        'Abre ese mismo PDF aquí otra vez y todo el banco vuelve tal como estaba.',
        'Está en el panel Banco, en Archivo del banco.',
      ],
      fr: [
        'Un seul fichier avec une photo du montage, le schéma, chaque connexion à cocher, la liste des pièces et le code.',
        'Rouvrez ce même PDF ici et tout le banc revient tel qu\'il était.',
        'Retrouvez-le dans le panneau Banc d\'essai, sous Fichier du banc.',
      ],
    },
    guide: 'workbench',
  },
  {
    id: '2026-11-18',
    title: {
      en: 'Part pictures, new buttons and kodeOS 0.1.2',
      'pt-BR': 'Fotos das peças, botões novos e kodeOS 0.1.2',
      es: 'Fotos de las piezas, botones nuevos y kodeOS 0.1.2',
      fr: 'Photos des pièces, nouveaux boutons et kodeOS 0.1.2',
    },
    points: {
      en: [
        'The parts library now shows a picture of each part.',
        'The Dot runs kodeOS 0.1.2, and follows new releases by itself.',
        'Five new buttons and switches: 2-pin, 6x6 and 12x12 tactile, latching, and a toggle switch.',
        'Lay the Dot flat, stand it up or on its side: right-click it on the workbench.',
      ],
      'pt-BR': [
        'A biblioteca de peças agora mostra uma foto de cada peça.',
        'O Dot roda o kodeOS 0.1.2 e acompanha as novas versões sozinho.',
        'Cinco botões e chaves novos: táctil de 2 pinos, 6x6 e 12x12, com trava, e chave alavanca.',
        'Deite o Dot, coloque de pé ou de lado: clique com o botão direito nele na mesa.',
      ],
      es: [
        'La biblioteca de piezas ahora muestra una foto de cada pieza.',
        'El Dot ejecuta kodeOS 0.1.2 y sigue las nuevas versiones por sí solo.',
        'Cinco botones e interruptores nuevos: táctil de 2 pines, 6x6 y 12x12, con retención, e interruptor de palanca.',
        'Acuesta el Dot, ponlo de pie o de lado: haz clic derecho sobre él en la mesa.',
      ],
      fr: [
        'La bibliothèque de pièces affiche maintenant une photo de chaque pièce.',
        'Le Dot exécute kodeOS 0.1.2 et suit les nouvelles versions tout seul.',
        'Cinq nouveaux boutons et interrupteurs : tactile à 2 broches, 6x6 et 12x12, à verrouillage, et interrupteur à bascule.',
        'Couchez le Dot, mettez-le debout ou sur le côté : faites un clic droit dessus sur le banc d\'essai.',
      ],
    },
    guide: 'workbench',
  },
];

/** The texts of an automatic entry. Short on purpose: the release itself is Kode's news, not ours. */
export function autoEntry(n: AutoNote): NewsEntry {
  const v = n.version;
  return {
    id: n.id,
    title: {
      en: `kodeOS updated to ${v}`,
      'pt-BR': `kodeOS atualizado para ${v}`,
      es: `kodeOS actualizado a ${v}`,
      fr: `kodeOS mis à jour vers ${v}`,
    },
    points: {
      en: [`The Dot now runs kodeOS ${v}, built from Kode's public release.`, 'Your apps and settings on the Dot were kept.'],
      'pt-BR': [`O Dot agora roda o kodeOS ${v}, compilado a partir da versão pública da Kode.`, 'Seus apps e ajustes no Dot foram mantidos.'],
      es: [`El Dot ahora ejecuta kodeOS ${v}, compilado a partir de la versión pública de Kode.`, 'Tus apps y ajustes en el Dot se mantienen.'],
      fr: [`Le Dot exécute maintenant kodeOS ${v}, compilé à partir de la version publique de Kode.`, 'Vos apps et réglages sur le Dot ont été conservés.'],
    },
  };
}

const isAutoNote = (x: unknown): x is AutoNote => {
  const n = x as Partial<AutoNote> | null;
  return !!n && typeof n === 'object' && typeof n.id === 'string' && /^\d{4}-\d{2}-\d{2}/.test(n.id) && n.kind === 'kodeos' && typeof n.version === 'string' && /^v\d+\.\d+\.\d+$/.test(n.version);
};

/** Hand-written and automatic entries as one list, newest first. A malformed automatic line is left out, never fatal. */
export function mergeChangelog(notes: readonly NewsEntry[], autoNotes: readonly unknown[]): NewsEntry[] {
  const seen = new Set<string>();
  return [...notes, ...autoNotes.filter(isAutoNote).map(autoEntry)]
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export const CHANGELOG: NewsEntry[] = mergeChangelog(NOTES, Array.isArray(auto) ? (auto as unknown[]) : []);
