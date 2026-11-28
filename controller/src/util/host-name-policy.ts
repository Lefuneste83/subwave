// A DJ never names another station presenter as the voice on air.
//
// Noticed on air: after the operator moved a show from one host to another
// mid-show, every station ident by the new host said "<station> με τον Τομ
// Άβρο" ("with Tom Avro"), seven times, on two different models. The ident's
// task line named the right host; the line still put a third persona, the
// previous show's presenter, on the mic, and once one such ident aired it fed
// the next prompt as the host's own words. Persona names are typed in Latin
// while the lines are written in the speaker's language, and models
// transliterate them (Tom Avro → Τομ Άβρο), so a plain string search misses
// exactly the case that aired.
//
// The rule, deliberately simple and the same for every language:
//
// - A model-written spoken line that NAMES a station persona who is not on the
//   air is judged. On the air means: the speaker, the on-air roster (the show's
//   host and its guests, the session's host), the voices of the exchange the
//   line belongs to, and the next show's presenter inside the final quarter
//   hour (the prompt itself offers that nod). The caller supplies those ids.
//   Introducing a self-introduction grammar per language ("with X", "this is
//   X", "I'm X", «με τον X», «c X») was rejected: the forms are open-ended,
//   and an off-air presenter has no business in an ident or a link anyway.
// - Kinds whose job is to name the other host are never judged: the show
//   handoff (`handoff`, its sign-off and greeting writers).
// - A name supplied for the line is not a persona: when the matched words also
//   occur in a supplied name (a track's artist, title or album, a requester),
//   the mention is that name. Only the words actually matched must occur, so an
//   artist "Avro" exempts "Avro" but not "Tom Avro".
// - Matching is cross-script. Both sides are folded to one Latin key: case and
//   diacritics off, Greek and Cyrillic transliterated (small tables below,
//   modern Greek digraphs first: μπ → b, ντ → d, ου → u), then a few
//   spelling-level reductions both sides go through (ph → f, th → t, c → k/s,
//   w → v, y → i, mp/mb → b, nt/nd → d, h dropped, z → s, e → i, u → o,
//   doubled letters single), so "Tom Avro" and «Τομ Άβρο» share a key.
//   Inflection is tolerated by one trailing vowel, `s`, or vowel+`s` on either
//   side («Άβρου» for Avro, «Τικάνη» for Tikanis, Russian «Эстебана»).
// - A name is matched as the whole name (every token, adjacent, in order), or
//   by ONE distinctive token: for a one-token name, that token; for a
//   two-token name, the surname (else the first name) when its key has at
//   least four letters. A leading title (DJ, MC, Mr, Dr …) does not count as a
//   token. Names of three or more tokens ("The Dead Professor", "Main Computer
//   MK-69") are matched whole only, because their single words are common
//   ones. In a cased script the match must be capitalised (any token for a
//   whole name, the token itself for a single one), which keeps an ordinary
//   lowercase word that happens to share a key from counting.
// - A token in a script the tables cannot transliterate (Han, kana, Hangul,
//   Arabic, Hebrew, Thai, the Indic scripts …) never matches: the rule fails
//   open there. Latin names inside such a line are still judged.
//
// The verdict per surface mirrors the script-leak guard: a free-text writer
// regenerates once (`retry: true` → `regenerate`), the speech gate drops what
// still names an off-air presenter (`drop`). Operator text (meta.verbatim, a
// RAW /dj/say) never reaches the policy, and pick notes, which never air, are
// not judged. Pinned by scripts/host-name-guard.test.ts.

export const HOST_NAMING_KINDS: ReadonlySet<string> = new Set([
  'handoff', 'generateSignoff', 'generateHandoffGreeting',
]);

const TITLE_TOKENS = new Set(['dj', 'mc', 'mr', 'mrs', 'ms', 'dr', 'sir', 'lady', 'dame']);

const GREEK_DIGRAPHS: Array<[RegExp, string]> = [
  [/ου/g, 'u'], [/ει/g, 'i'], [/οι/g, 'i'], [/υι/g, 'i'], [/αι/g, 'e'],
  [/μπ/g, 'mp'], [/ντ/g, 'nt'], [/γκ/g, 'gk'], [/γγ/g, 'ng'], [/τσ/g, 'ts'], [/τζ/g, 'dz'],
];
const GREEK: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'ks', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'i', φ: 'f', χ: 'h', ψ: 'ps', ω: 'o',
};
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'z', з: 'z', и: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ts', ш: 's', щ: 's', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia', і: 'i', ї: 'i', є: 'e',
  ґ: 'g', ў: 'u', ј: 'j', љ: 'l', њ: 'n', ћ: 'ts', ђ: 'dz', џ: 'dz', ѕ: 'dz',
};
const LATIN_EXTRA: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };
const REDUCTIONS: Array<[RegExp, string]> = [
  [/sch/g, 's'], [/sh/g, 's'], [/ch/g, 'ts'], [/ph/g, 'f'], [/th/g, 't'], [/gh/g, 'g'], [/kh/g, 'h'],
  [/ck/g, 'k'], [/c(?=[eiy])/g, 's'], [/c/g, 'k'], [/q/g, 'k'], [/x/g, 'ks'], [/w/g, 'v'], [/y/g, 'i'],
  [/j/g, 'dz'], [/mp/g, 'b'], [/mb/g, 'b'], [/nt/g, 'd'], [/nd/g, 'd'], [/gk/g, 'g'], [/ng/g, 'g'],
  [/ou/g, 'u'], [/oo/g, 'u'], [/h/g, ''], [/z/g, 's'], [/e/g, 'i'], [/u/g, 'o'], [/(.)\1+/g, '$1'],
];

const TRANSLITERABLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{M}]+$/u;
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

// The cross-script key of one word, or null when its script has no table
// here (the rule fails open on it).
export function nameKey(word: string): string | null {
  if (!word || !TRANSLITERABLE.test(word)) return null;
  let s = word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  for (const [re, to] of GREEK_DIGRAPHS) s = s.replace(re, to);
  s = s.replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (ch) => GREEK[ch] ?? CYRILLIC[ch] ?? '');
  s = s.replace(/[ßæœøđðłþı]/g, (ch) => LATIN_EXTRA[ch] ?? ch);
  for (const [re, to] of REDUCTIONS) s = s.replace(re, to);
  return s;
}

interface Token { raw: string; key: string | null; cap: boolean }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of String(text ?? '').matchAll(TOKEN)) {
    const raw = m[0];
    const first = raw.charAt(0);
    out.push({ raw, key: nameKey(raw), cap: first !== first.toLowerCase() });
  }
  return out;
}

// One trailing vowel, `s`, or vowel+`s` (keys hold only a/i/o as vowels).
function stem(key: string): string {
  const cut = key.replace(/(?:[aio]s|[aios])$/, '');
  return cut.length >= 3 ? cut : key;
}

function sameWord(lineKey: string | null, nameKeyValue: string | null): boolean {
  if (!lineKey || !nameKeyValue) return false;
  if (lineKey === nameKeyValue) return true;
  const a = stem(lineKey);
  const b = stem(nameKeyValue);
  return a === nameKeyValue || lineKey === b || a === b;
}

interface NameShape { whole: (string | null)[]; single: string | null }

function nameShape(name: string): NameShape | null {
  let toks = tokenize(name).map(t => t.key).filter((k): k is string => !!k);
  while (toks.length > 1 && TITLE_TOKENS.has(toks[0])) toks = toks.slice(1);
  if (!toks.length) return null;
  let single: string | null = null;
  if (toks.length === 1) single = toks[0].length >= 4 ? toks[0] : null;
  else if (toks.length === 2) single = toks[1].length >= 4 ? toks[1] : (toks[0].length >= 4 ? toks[0] : null);
  return { whole: toks, single };
}

// Positions [start, end) where `keys` occur adjacent and in order.
function runsOf(line: Token[], keys: readonly (string | null)[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + keys.length <= line.length; i++) {
    let ok = true;
    for (let j = 0; j < keys.length && ok; j++) ok = sameWord(line[i + j].key, keys[j]);
    if (ok) out.push([i, i + keys.length]);
  }
  return out;
}

export interface HostNameInput {
  /** The surface kind (queue kind, or the writer's `kind`). */
  kind?: string | null;
  speaker?: { id?: unknown; name?: unknown } | null;
  /** Every station persona (settings.personas). */
  personas: readonly ({ id?: unknown; name?: unknown } | null | undefined)[];
  /** Persona ids that are on the air for this line (roster, cast, next presenter). */
  onAir?: readonly unknown[];
  /** Names supplied for the line (tracks, requesters…). */
  names?: readonly unknown[];
  /** A writer that may regenerate once. */
  retry?: boolean;
}

export interface WrongHost { personaId: string; personaName: string; said: string }

export type HostNameVerdict =
  | { action: 'keep' }
  | { action: 'regenerate' | 'drop'; named: WrongHost[] };

// The off-air presenters a line names, after every exemption above.
export function wrongHostNames(text: string, input: HostNameInput): WrongHost[] {
  if (!text || HOST_NAMING_KINDS.has(String(input.kind ?? ''))) return [];
  const line = tokenize(text);
  if (!line.length) return [];
  const speakerId = input.speaker?.id == null ? null : String(input.speaker.id);
  const speakerName = typeof input.speaker?.name === 'string' ? input.speaker.name : '';
  const speakerKeys = tokenize(speakerName).map(t => t.key).filter(Boolean);
  const onAir = new Set((input.onAir ?? []).filter(v => v != null).map(String));
  if (speakerId) onAir.add(speakerId);
  const supplied = (input.names ?? [])
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map(n => tokenize(n));
  const isSupplied = (run: Token[]): boolean => supplied.some(name => runsOf(name, run.map(t => t.key)).length > 0);
  const out: WrongHost[] = [];
  for (const p of input.personas ?? []) {
    const id = p?.id == null ? '' : String(p.id);
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!id || !name || onAir.has(id) || name === speakerName) continue;
    const shape = nameShape(name);
    if (!shape) continue;
    let said: string | null = null;
    for (const [a, b] of runsOf(line, shape.whole)) {
      const run = line.slice(a, b);
      if (!run.some(t => t.cap) || isSupplied(run)) continue;
      said = run.map(t => t.raw).join(' ');
      break;
    }
    if (!said && shape.single && !speakerKeys.some(k => sameWord(k, shape.single))) {
      for (const [a, b] of runsOf(line, [shape.single])) {
        const run = line.slice(a, b);
        if (!run[0].cap || isSupplied(run)) continue;
        said = run[0].raw;
        break;
      }
    }
    if (said) out.push({ personaId: id, personaName: name, said });
  }
  return out;
}

export function hostNameVerdict(text: string, input: HostNameInput): HostNameVerdict {
  const named = wrongHostNames(text, input);
  if (!named.length) return { action: 'keep' };
  return { action: input.retry ? 'regenerate' : 'drop', named };
}
