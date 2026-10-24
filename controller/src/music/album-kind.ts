// What an era-suspect album IS (Library → Era). A policy module: the walk
// pre-fills a kind from the album title when the operator has not set one, and
// the admin tab offers the decision that usually fits each kind. The kind list
// itself lives in schemas/show.ts (ALBUM_KINDS), because a show can leave whole
// kinds out and schema modules import only zod.
//
// The suggestion reads the TITLE first and the detector's reason only as a
// tie-break: the detector says why an album looked suspect (a compilation tag,
// several artists), which every kind can share, so it is no answer to "what is
// it". A wrong guess costs one click in the dropdown; a missing guess leaves
// the album "unclassified". The kind steers the air only through a show's
// `excludedAlbumKinds`, so a guess never hides a track on its own.

import { ALBUM_KINDS, type AlbumKind } from '../schemas/show.js';

export { ALBUM_KINDS, type AlbumKind };

/** The three ways out of the Era list (era_override.verdict). */
export type EraDecision = 'trusted' | 'year' | 'suspect';

export function isAlbumKind(v: unknown): v is AlbumKind {
  return typeof v === 'string' && (ALBUM_KINDS as readonly string[]).includes(v);
}

// First match wins, in this order: the specific shapes before the broad ones
// ("Live at the Soundtrack Festival" is live; "DJ-Kicks: The Best Of" a mix).
const RULES: Array<[AlbumKind, RegExp]> = [
  ['dj-mix', /\b(?:dj[- ]?kicks|dj[- ]mix(?:ed)?|mixed by|continuous mix|mix compilation|fabric(?:live)? ?\d+|global underground|back to mine|late night tales|balance \d+|essential mix|the mix|in the mix)\b/i],
  ['soundtrack', /\b(?:soundtrack|o\.?s\.?t\.?|original (?:motion picture|score|cast|television)|music from (?:and inspired by )?(?:the )?(?:motion picture|film|series|game)|(?:film|movie|game) music)\b/i],
  ['tribute', /\b(?:tribute|covers?|salutes?|sings|plays the music of|in the style of|reimagined)\b/i],
  ['sampler', /\b(?:sampler|promo(?:tional)?|cover ?(?:cd|mount)|uncut presents|mojo presents|free cd)\b/i],
  ['reissue', /\b(?:remaster(?:ed)?|deluxe|reissue|expanded|anniversary|legacy edition|special edition|collector'?s edition|bonus tracks?)\b/i],
  ['box-set', /\b(?:box ?set|the complete (?:recordings|works|albums|collection)|\d+ ?cd)\b/i],
  ['live', /\b(?:live (?:at|in|from|on)|festival|unplugged|in concert)\b/i],
  ['dj-choice', /\b(?:selected by|compiled by|curated by|chosen by|selections? by|'s choice|dj choice|playlist)\b/i],
  ['chart', /\b(?:now that'?s what i call|top \d+|hits? (?:of )?(?:19|20)\d\d|(?:19|20)\d\d hits|chart|hit ?parade)\b/i],
  ['label', /\b(?:records|recordings) (?:presents|sampler|selection|collection)\b|\b\d+ releases\b/i],
  ['best-of', /\b(?:best of|greatest hits|the very best|anthology|the collection|singles|essential|retrospective|rarities|b-sides|gold|definitive)\b/i],
];

// One year in the title, not a range: "Techno 2019", "Ibiza 2004", "Summer 1998".
const SINGLE_YEAR = /\b(?:19|20)\d\d\b/;
const YEAR_RANGE = /\b(?:19|20)\d\d\s*[-–—/]\s*(?:(?:19|20)?\d\d)\b/;

export interface KindInput {
  album?: string | null;
  /** era-suspect.ts's marker for this album, when it flagged it. */
  reason?: string | null;
}

/** The kind to pre-fill for a flagged album, or null for "unclassified". */
export function suggestAlbumKind({ album, reason }: KindInput): AlbumKind | null {
  const title = String(album ?? '');
  for (const [kind, re] of RULES) if (re.test(title)) return kind;
  const multi = reason === 'various-artists' || reason === 'many-artists';
  // A dated various-artists record ("Techno 2019"): one known year by design.
  if (multi && SINGLE_YEAR.test(title) && !YEAR_RANGE.test(title)) return 'chart';
  // One artist, a span of years in the title ("Singles 1968-1974").
  if (reason === 'title-year-range' || reason === 'title-compilation') return 'best-of';
  // Several artists and nothing more specific: a themed compilation is the
  // common case ("Années 80", "Cowabunga! The Surf Box").
  if (multi) return 'themed';
  return null;
}

/** The decision that usually fits a kind, which the tab highlights. */
export function suggestedDecision(kind: AlbumKind | null): EraDecision | null {
  switch (kind) {
    case 'original-album':
    case 'tribute':
    case 'chart':
    case 'label':
    case 'sampler':
    case 'dj-mix':
    case 'live':
      return 'trusted';
    case 'reissue':
      return 'year';
    case 'best-of':
    case 'themed':
    case 'dj-choice':
    case 'soundtrack':
    case 'box-set':
      return 'suspect';
    default:
      return null;
  }
}
