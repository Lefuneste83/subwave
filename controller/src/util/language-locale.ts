// The BCP 47 locale a persona's language is written in, and the calendar date
// rendered in it. A persona's language is free text ("Greek", "Ελληνικά",
// "el", "Brazilian Portuguese"), and a model handed the English day and month
// ("Thursday, 26 November") translates them itself, which a small model gets
// wrong on air (a Thursday aired as Tuesday, November as February). Rendering
// the date through Intl in the persona's own locale hands it the exact words
// instead, for every language ICU knows rather than a hand-kept table.
//
// Recognition reuses the script-leak policy's language table (names in English
// and natively, ISO 639-1/-3 codes), so the two never disagree about what a
// language is. A table entry can group several languages (Yoruba, Igbo, Hausa,
// …), so a name is resolved in this order: an input that is itself a locale
// code ICU formats ("el", "pt-BR", "zh_TW", "gre"); then the language's own
// name as Intl.DisplayNames gives it, in English and natively, for every code
// the table lists; then the table's other names (aliases such as "Farsi" or
// "Castellano"), which take their entry's first code; each tried first on the
// whole string and then word by word ("Greek (Cyprus)", "Brazilian
// Portuguese"). Matching folds case and accents ("ελληνικα" is "Ελληνικά").
//
// Fails closed to "no locale": an unrecognised language, one ICU cannot
// format, or English returns null, and the caller then adds nothing, so an
// English station and an unknown language keep the prompt they always had.
// Pure apart from a memo; Node's official images ship full ICU (78 on Node 22).

import { knownLanguages } from './script-leak-policy.js';

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const CODE_SHAPE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

function supported(locale: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale.replace(/_/g, '-'));
    if (!canonical) return null;
    return Intl.DateTimeFormat.supportedLocalesOf([canonical]).length ? canonical : null;
  } catch {
    return null;
  }
}

let nameIndex: Map<string, string> | null = null;

function index(): Map<string, string> {
  if (nameIndex) return nameIndex;
  const map = new Map<string, string>();
  const english = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  const entries = knownLanguages();
  // Intl's own names first: they name exactly one language each.
  for (const entry of entries) {
    for (const code of entry.codes) {
      const locale = supported(code);
      if (!locale) continue;
      const names = [english.of(locale)];
      try {
        names.push(new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(locale));
      } catch { /* no native display data */ }
      for (const name of names) if (name && !map.has(fold(name))) map.set(fold(name), locale);
    }
  }
  // Then the table's aliases, which only fill gaps.
  for (const entry of entries) {
    const first = entry.codes.map(supported).find(Boolean);
    if (!first) continue;
    for (const name of entry.names) if (!map.has(fold(name))) map.set(fold(name), first);
  }
  nameIndex = map;
  return map;
}

const memo = new Map<string, string | null>();

/** The locale a language is formatted in, or null when it is unknown to ICU. */
export function languageLocale(language: unknown): string | null {
  const raw = String(language ?? '').normalize('NFC').trim();
  if (!raw) return null;
  if (memo.has(raw)) return memo.get(raw)!;
  let out: string | null = null;
  if (CODE_SHAPE.test(raw)) out = supported(raw);
  if (!out) {
    const names = index();
    out = names.get(fold(raw)) ?? null;
    if (!out) {
      for (const word of fold(raw).match(/[\p{L}'ʻ]+/gu) ?? []) {
        const hit = names.get(word);
        if (hit) { out = hit; break; }
      }
    }
  }
  memo.set(raw, out);
  return out;
}

/**
 * "Πέμπτη 26 Νοεμβρίου" for a Greek persona on 2026-11-26: the weekday, day
 * and month of a station-zone calendar date (`YYYY-MM-DD`, getDateContext's
 * `iso`) in the language's own words. Null for English, for an unknown
 * language and for a malformed date. The date is already the station's, so it
 * is formatted at noon UTC and cannot slip a day, in the Gregorian calendar.
 */
export function localizedDayLabel(isoDate: unknown, language: unknown): string | null {
  const locale = languageLocale(language);
  if (!locale || locale.split('-')[0] === 'en') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate ?? ''))) return null;
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  // Gregorian whatever the locale's default calendar (Persian, Buddhist,
  // Islamic): the line sits beside the English one and must name the same day.
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC', calendar: 'gregory',
  }).format(at);
}
