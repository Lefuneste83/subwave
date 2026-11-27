// Is a model-written line carrying a word from a writing system its speaker's
// language does not use? A model trained mostly on one language drops a word
// of it into another now and then, mid-word or mid-sentence: a Greek pick note
// read "124 BPM驱动βήμα", a Greek link "τηνAA自身 του", another "но σκοτεινό".
// The voice then reads noise on air and the Booth shows it. This is the one
// test for it, for every persona language this table knows, not one pair.
//
// Each language maps to the Unicode scripts it is written in (Greek → Greek,
// Japanese → Han + Hiragana + Katakana, Korean → Hangul + Han, Serbian →
// Cyrillic, …). Latin is always allowed: artist and track names, genre words
// and BPM/key notation are written in it on every station. Digits,
// punctuation, symbols and emoji are not letters and never leak, and neither
// is a letter Unicode files under no one script (Common or Inherited: the
// kana long-vowel mark, a combining accent).
//
// A letter outside the allowed set is a leak unless the text the model was
// handed carries it: `names` are the names supplied for the line (track,
// artist and album, show, station and persona names, places), or the prompt
// itself where the caller has it. A foreign run is exempt when any supplied
// text contains it (case- and width-folded), so a Japanese artist in a Greek
// line, or a Greek album title in an English one, stays.
//
// Fail open, so an upgrade is byte-identical wherever the guard cannot judge:
// a language the table does not recognise (in the primary or any mixed-in
// language) switches the guard off, and so does a line written MOSTLY in the
// foreign script: that is the persona's real language, misdeclared, or a whole
// language switch, and dropping it would silence a station whose language
// field is simply wrong. A leak is a minority of the line's letters. An unset
// language is the product's English default (settings.personaLanguages).
//
// What a leak costs depends on where the line goes, and that severity split is
// decided here too (scriptLeakVerdict), not at the call sites. A SPOKEN line
// with a stray word is incomprehensible on air: it is regenerated once where
// the writer can afford a retry (llm djText `speaker`), and otherwise, or when
// the retry leaks again, dropped whole like a stand-in (broadcast/queue.ts
// speakable). A pick NOTE is read in the Booth, never aired, so a stray word
// there is minor: only the foreign runs come out and the rest of the note
// stays; the route's plain credit (“Title” — Artist) replaces it only when
// too little is left to mean anything (dj-agent/pick-note.ts). Pure. Operator
// text (meta.verbatim) is never judged.
//
// Two repairs come before that judgement, and neither is a leak on any
// surface (the verdict `fold`: the mended line goes on, spoken or read). A
// look-alike letter of another script inside a word is written back in the
// word's script (homoglyphFold), and a word gluing the speaker's script to
// Latin is folded or split at a supplied name when it can be, else judged as
// a mixed word (mixedTokens). A line the guard rewrites has its stray
// fullwidth punctuation made ASCII (withAsciiPunctuation).

export type ScriptName =
  | 'Latin' | 'Greek' | 'Cyrillic' | 'Armenian' | 'Georgian' | 'Hebrew' | 'Arabic' | 'Syriac' | 'Thaana'
  | 'Devanagari' | 'Bengali' | 'Gurmukhi' | 'Gujarati' | 'Oriya' | 'Tamil' | 'Telugu' | 'Kannada' | 'Malayalam'
  | 'Sinhala' | 'Thai' | 'Lao' | 'Tibetan' | 'Myanmar' | 'Khmer' | 'Ethiopic' | 'Hangul' | 'Hiragana' | 'Katakana'
  | 'Han' | 'Bopomofo' | 'Mongolian' | 'Cherokee' | 'Tifinagh';

const KNOWN_SCRIPTS: readonly ScriptName[] = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Ethiopic', 'Hangul', 'Hiragana', 'Katakana',
  'Han', 'Bopomofo', 'Mongolian', 'Cherokee', 'Tifinagh',
];

type Entry = { scripts: readonly ScriptName[]; names: readonly string[]; codes: readonly string[] };

const LATIN: readonly ScriptName[] = ['Latin'];

// English and native names (lower case), and ISO 639-1/-3 codes. A language
// written in Latin needs listing only so the guard knows it: Latin is always
// allowed anyway.
const LANGUAGES: readonly Entry[] = [
  { scripts: LATIN, names: ['english', 'anglais', 'inglés', 'ingles', 'englisch', 'inglese'], codes: ['en', 'eng'] },
  { scripts: LATIN, names: ['french', 'français', 'francais'], codes: ['fr', 'fra', 'fre'] },
  { scripts: LATIN, names: ['spanish', 'español', 'espanol', 'castilian', 'castellano'], codes: ['es', 'spa'] },
  { scripts: LATIN, names: ['german', 'deutsch'], codes: ['de', 'deu', 'ger'] },
  { scripts: LATIN, names: ['italian', 'italiano'], codes: ['it', 'ita'] },
  { scripts: LATIN, names: ['portuguese', 'português', 'portugues'], codes: ['pt', 'por'] },
  { scripts: LATIN, names: ['dutch', 'flemish', 'nederlands', 'vlaams'], codes: ['nl', 'nld', 'dut'] },
  { scripts: LATIN, names: ['afrikaans'], codes: ['af', 'afr'] },
  { scripts: LATIN, names: ['swedish', 'svenska'], codes: ['sv', 'swe'] },
  { scripts: LATIN, names: ['norwegian', 'norsk', 'bokmål', 'bokmal', 'nynorsk'], codes: ['no', 'nb', 'nn', 'nor', 'nob', 'nno'] },
  { scripts: LATIN, names: ['danish', 'dansk'], codes: ['da', 'dan'] },
  { scripts: LATIN, names: ['finnish', 'suomi'], codes: ['fi', 'fin'] },
  { scripts: LATIN, names: ['icelandic', 'íslenska', 'islenska'], codes: ['is', 'isl', 'ice'] },
  { scripts: LATIN, names: ['faroese', 'føroyskt'], codes: ['fo', 'fao'] },
  { scripts: LATIN, names: ['estonian', 'eesti'], codes: ['et', 'est'] },
  { scripts: LATIN, names: ['latvian', 'latviešu'], codes: ['lv', 'lav'] },
  { scripts: LATIN, names: ['lithuanian', 'lietuvių'], codes: ['lt', 'lit'] },
  { scripts: LATIN, names: ['polish', 'polski'], codes: ['pl', 'pol'] },
  { scripts: LATIN, names: ['czech', 'čeština', 'cestina'], codes: ['cs', 'ces', 'cze'] },
  { scripts: LATIN, names: ['slovak', 'slovenčina'], codes: ['sk', 'slk', 'slo'] },
  { scripts: LATIN, names: ['slovenian', 'slovene', 'slovenščina'], codes: ['sl', 'slv'] },
  { scripts: LATIN, names: ['croatian', 'hrvatski'], codes: ['hr', 'hrv'] },
  { scripts: LATIN, names: ['bosnian', 'bosanski'], codes: ['bs', 'bos'] },
  { scripts: LATIN, names: ['hungarian', 'magyar'], codes: ['hu', 'hun'] },
  { scripts: LATIN, names: ['romanian', 'moldovan', 'română', 'romana'], codes: ['ro', 'ron', 'rum'] },
  { scripts: LATIN, names: ['albanian', 'shqip'], codes: ['sq', 'sqi', 'alb'] },
  { scripts: LATIN, names: ['maltese', 'malti'], codes: ['mt', 'mlt'] },
  { scripts: LATIN, names: ['irish', 'gaeilge', 'gaelic', 'gàidhlig'], codes: ['ga', 'gle', 'gd', 'gla'] },
  { scripts: LATIN, names: ['welsh', 'cymraeg'], codes: ['cy', 'cym', 'wel'] },
  { scripts: LATIN, names: ['breton', 'brezhoneg'], codes: ['br', 'bre'] },
  { scripts: LATIN, names: ['basque', 'euskara'], codes: ['eu', 'eus', 'baq'] },
  { scripts: LATIN, names: ['catalan', 'valencian', 'català', 'catala'], codes: ['ca', 'cat'] },
  { scripts: LATIN, names: ['galician', 'galego'], codes: ['gl', 'glg'] },
  { scripts: LATIN, names: ['occitan'], codes: ['oc', 'oci'] },
  { scripts: LATIN, names: ['corsican', 'corsu'], codes: ['co', 'cos'] },
  { scripts: LATIN, names: ['luxembourgish', 'lëtzebuergesch'], codes: ['lb', 'ltz'] },
  { scripts: LATIN, names: ['frisian', 'frysk'], codes: ['fy', 'fry'] },
  { scripts: LATIN, names: ['esperanto'], codes: ['eo', 'epo'] },
  { scripts: LATIN, names: ['latin', 'latina'], codes: ['la', 'lat'] },
  { scripts: LATIN, names: ['turkish', 'türkçe', 'turkce'], codes: ['tr', 'tur'] },
  { scripts: LATIN, names: ['azerbaijani', 'azeri', 'azərbaycan'], codes: ['az', 'aze'] },
  { scripts: ['Latin', 'Cyrillic'], names: ['uzbek', 'oʻzbek', "o'zbek"], codes: ['uz', 'uzb'] },
  { scripts: LATIN, names: ['turkmen'], codes: ['tk', 'tuk'] },
  { scripts: LATIN, names: ['indonesian', 'bahasa', 'malay', 'melayu'], codes: ['id', 'ind', 'ms', 'msa', 'may'] },
  { scripts: LATIN, names: ['tagalog', 'filipino', 'cebuano'], codes: ['tl', 'tgl', 'fil', 'ceb'] },
  { scripts: LATIN, names: ['vietnamese', 'tiếng việt'], codes: ['vi', 'vie'] },
  { scripts: LATIN, names: ['swahili', 'kiswahili'], codes: ['sw', 'swa'] },
  { scripts: LATIN, names: ['yoruba', 'igbo', 'hausa', 'zulu', 'isizulu', 'xhosa', 'isixhosa', 'somali', 'wolof', 'shona', 'sesotho', 'setswana', 'tswana', 'kinyarwanda', 'lingala', 'oromo'], codes: ['yo', 'yor', 'ig', 'ibo', 'ha', 'hau', 'zu', 'zul', 'xh', 'xho', 'so', 'som', 'wo', 'wol', 'sn', 'sna', 'st', 'sot', 'tn', 'tsn', 'rw', 'kin', 'ln', 'lin', 'om', 'orm'] },
  { scripts: LATIN, names: ['malagasy', 'hawaiian', 'maori', 'māori', 'samoan', 'tongan', 'fijian'], codes: ['mg', 'mlg', 'haw', 'mi', 'mri', 'sm', 'smo', 'to', 'ton', 'fj', 'fij'] },
  { scripts: LATIN, names: ['quechua', 'guarani', 'aymara', 'haitian', 'kreyòl', 'papiamento'], codes: ['qu', 'que', 'gn', 'grn', 'ay', 'aym', 'ht', 'hat', 'pap'] },
  { scripts: ['Latin', 'Arabic'], names: ['kurdish', 'kurmanji', 'sorani', 'kurdî'], codes: ['ku', 'kur', 'ckb', 'kmr'] },
  { scripts: ['Greek'], names: ['greek', 'ελληνικά', 'ελληνικα'], codes: ['el', 'ell', 'gre'] },
  { scripts: ['Cyrillic'], names: ['russian', 'русский'], codes: ['ru', 'rus'] },
  { scripts: ['Cyrillic'], names: ['ukrainian', 'українська'], codes: ['uk', 'ukr'] },
  { scripts: ['Cyrillic'], names: ['belarusian', 'беларуская'], codes: ['be', 'bel'] },
  { scripts: ['Cyrillic'], names: ['bulgarian', 'български'], codes: ['bg', 'bul'] },
  { scripts: ['Cyrillic'], names: ['macedonian', 'македонски'], codes: ['mk', 'mkd', 'mac'] },
  { scripts: ['Cyrillic'], names: ['serbian', 'montenegrin', 'српски', 'srpski'], codes: ['sr', 'srp', 'cnr'] },
  { scripts: ['Cyrillic'], names: ['kazakh', 'қазақ', 'kyrgyz', 'кыргыз', 'tajik', 'тоҷикӣ', 'tatar', 'татар', 'bashkir', 'chuvash', 'yakut'], codes: ['kk', 'kaz', 'ky', 'kir', 'tg', 'tgk', 'tt', 'tat', 'ba', 'bak', 'cv', 'chv', 'sah'] },
  { scripts: ['Cyrillic', 'Mongolian'], names: ['mongolian', 'монгол'], codes: ['mn', 'mon'] },
  { scripts: ['Armenian'], names: ['armenian', 'հայերեն'], codes: ['hy', 'hye', 'arm'] },
  { scripts: ['Georgian'], names: ['georgian', 'ქართული'], codes: ['ka', 'kat', 'geo'] },
  { scripts: ['Hebrew'], names: ['hebrew', 'עברית', 'yiddish', 'ייִדיש'], codes: ['he', 'heb', 'iw', 'yi', 'yid'] },
  { scripts: ['Arabic'], names: ['arabic', 'العربية', 'عربي'], codes: ['ar', 'ara'] },
  { scripts: ['Arabic'], names: ['persian', 'farsi', 'dari', 'فارسی'], codes: ['fa', 'fas', 'per', 'prs'] },
  { scripts: ['Arabic'], names: ['urdu', 'اردو', 'pashto', 'pushto', 'پښتو', 'sindhi', 'uyghur', 'uighur'], codes: ['ur', 'urd', 'ps', 'pus', 'sd', 'snd', 'ug', 'uig'] },
  { scripts: ['Syriac'], names: ['syriac', 'aramaic'], codes: ['syr', 'arc'] },
  { scripts: ['Thaana'], names: ['dhivehi', 'maldivian'], codes: ['dv', 'div'] },
  { scripts: ['Devanagari'], names: ['hindi', 'हिन्दी', 'हिंदी', 'marathi', 'मराठी', 'nepali', 'नेपाली', 'sanskrit', 'konkani', 'maithili', 'bhojpuri', 'dogri'], codes: ['hi', 'hin', 'mr', 'mar', 'ne', 'nep', 'sa', 'san', 'kok', 'mai', 'bho', 'doi'] },
  { scripts: ['Bengali'], names: ['bengali', 'bangla', 'বাংলা', 'assamese'], codes: ['bn', 'ben', 'as', 'asm'] },
  { scripts: ['Gurmukhi', 'Arabic'], names: ['punjabi', 'panjabi', 'ਪੰਜਾਬੀ'], codes: ['pa', 'pan'] },
  { scripts: ['Gujarati'], names: ['gujarati', 'ગુજરાતી'], codes: ['gu', 'guj'] },
  { scripts: ['Oriya'], names: ['odia', 'oriya'], codes: ['or', 'ori'] },
  { scripts: ['Tamil'], names: ['tamil', 'தமிழ்'], codes: ['ta', 'tam'] },
  { scripts: ['Telugu'], names: ['telugu', 'తెలుగు'], codes: ['te', 'tel'] },
  { scripts: ['Kannada'], names: ['kannada', 'ಕನ್ನಡ'], codes: ['kn', 'kan'] },
  { scripts: ['Malayalam'], names: ['malayalam', 'മലയാളം'], codes: ['ml', 'mal'] },
  { scripts: ['Sinhala'], names: ['sinhala', 'sinhalese', 'සිංහල'], codes: ['si', 'sin'] },
  { scripts: ['Thai'], names: ['thai', 'ไทย'], codes: ['th', 'tha'] },
  { scripts: ['Lao'], names: ['lao', 'laotian', 'ລາວ'], codes: ['lo', 'lao'] },
  { scripts: ['Khmer'], names: ['khmer', 'cambodian', 'ខ្មែរ'], codes: ['km', 'khm'] },
  { scripts: ['Myanmar'], names: ['burmese', 'myanmar', 'မြန်မာ'], codes: ['my', 'mya', 'bur'] },
  { scripts: ['Tibetan'], names: ['tibetan', 'dzongkha'], codes: ['bo', 'bod', 'tib', 'dz', 'dzo'] },
  { scripts: ['Ethiopic'], names: ['amharic', 'አማርኛ', 'tigrinya', 'ትግርኛ'], codes: ['am', 'amh', 'ti', 'tir'] },
  { scripts: ['Cherokee'], names: ['cherokee'], codes: ['chr'] },
  { scripts: ['Latin', 'Tifinagh'], names: ['berber', 'tamazight', 'kabyle'], codes: ['ber', 'tzm', 'zgh', 'kab'] },
  { scripts: ['Hangul', 'Han'], names: ['korean', 'hangugeo', '한국어', '조선어'], codes: ['ko', 'kor'] },
  { scripts: ['Han', 'Hiragana', 'Katakana'], names: ['japanese', 'nihongo', '日本語'], codes: ['ja', 'jpn'] },
  {
    scripts: ['Han', 'Bopomofo'],
    names: ['chinese', 'mandarin', 'cantonese', 'putonghua', 'taiwanese', 'hokkien', 'hakka', 'shanghainese', '中文', '汉语', '漢語', '普通话', '普通話', '国语', '國語', '粤语', '粵語', '廣東話', '广东话', '简体中文', '繁體中文', '繁体中文'],
    codes: ['zh', 'zho', 'chi', 'cmn', 'yue', 'nan', 'hak', 'wuu'],
  },
];

const BY_NAME = new Map<string, readonly ScriptName[]>();
const BY_CODE = new Map<string, readonly ScriptName[]>();
for (const entry of LANGUAGES) {
  for (const name of entry.names) BY_NAME.set(name.normalize('NFC'), entry.scripts);
  for (const code of entry.codes) BY_CODE.set(code, entry.scripts);
}

/**
 * The language table's names and codes, read-only, for the one other reader
 * that needs a language recognised rather than its scripts: the persona's
 * date locale (util/language-locale.ts). One table, so the two cannot drift.
 */
export function knownLanguages(): ReadonlyArray<{ readonly names: readonly string[]; readonly codes: readonly string[] }> {
  return LANGUAGES;
}

const CODE = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/;
const WORD = /[\p{L}\p{M}'ʻ]+/gu;

/**
 * The scripts one language entry is written in, or null when the table does
 * not know it. A whole-entry code with any subtags (`el`, `zh-Hant`, `ja_JP`),
 * else every known language named in the entry as a word ("English (UK)",
 * "Brazilian Portuguese", "Ελληνικά").
 */
export function languageScripts(language: unknown): readonly ScriptName[] | null {
  const raw = String(language ?? '').normalize('NFC').trim().toLowerCase();
  if (!raw) return null;
  const code = CODE.exec(raw);
  if (code) {
    const hit = BY_CODE.get(code[1]);
    if (hit) return hit;
  }
  const whole = BY_NAME.get(raw);
  if (whole) return whole;
  const found = new Set<ScriptName>();
  for (const word of raw.match(WORD) ?? []) {
    for (const s of BY_NAME.get(word) ?? []) found.add(s);
  }
  return found.size ? [...found] : null;
}

/**
 * The scripts a speaker may write in: Latin plus every script of the primary
 * and mixed-in languages (settings.personaLanguages' shape). Null when any of
 * those languages is unknown: the guard then does nothing.
 */
export function allowedScripts(languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined): Set<ScriptName> | null {
  const all = [languages?.primary || 'English', ...(languages?.mix ?? [])];
  const allowed = new Set<ScriptName>(LATIN);
  for (const lang of all) {
    const scripts = languageScripts(lang);
    if (!scripts) return null;
    for (const s of scripts) allowed.add(s);
  }
  return allowed;
}

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const SCRIPT_RE = new Map<ScriptName, RegExp>(KNOWN_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]));
const allowedReCache = new Map<string, RegExp>();

function allowedLetterRe(allowed: Set<ScriptName>): RegExp {
  const key = [...allowed].sort().join(',');
  let re = allowedReCache.get(key);
  if (!re) {
    re = new RegExp(`[${[...allowed].map((s) => `\\p{Script=${s}}`).join('')}\\p{Script=Common}\\p{Script=Inherited}]`, 'u');
    allowedReCache.set(key, re);
  }
  return re;
}

function scriptOf(run: string): string {
  const first = [...run].find((ch) => LETTER.test(ch)) ?? '';
  for (const [name, re] of SCRIPT_RE) if (re.test(first)) return name;
  return 'Other';
}

function fold(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function letterCount(text: string): number {
  let n = 0;
  for (const ch of text) if (LETTER.test(ch)) n++;
  return n;
}

export interface ScriptLeak {
  /** The offending runs, in order of first appearance, de-duplicated. */
  runs: string[];
  /** The scripts those runs are written in (`Han`, `Cyrillic`, …). */
  scripts: string[];
}

/** A look-alike run written back in its neighbours' script (`ар` → `αρ`). */
export interface ScriptFold {
  from: string;
  to: string;
}

// Homoglyphs. A model writing one script now and then types a letter of
// another that looks the same, inside a word of its own: a Greek note read
// "арμονικά" with a Cyrillic а and р, an English line "Hellо" with a Cyrillic
// о. That is no foreign word: taking the run out breaks the word ("μονικά"),
// and dropping a spoken line for it loses a line the listener would have heard
// right. Such a run is written back in the script of the letters it touches.
//
// Each row is one look-alike letter in Latin, Greek and Cyrillic ('' where a
// script has none), from the Unicode confusables data, kept to letters that
// read the same in an ordinary font and reviewed by hand: no small capitals,
// no rare historic letters. Only these three scripts share shapes enough to
// matter; a run in any other script never folds.
const CONFUSABLES: ReadonlyArray<readonly [latin: string, greek: string, cyrillic: string]> = [
  ['a', 'α', 'а'], ['c', '', 'с'], ['e', '', 'е'], ['h', '', 'һ'], ['i', 'ι', 'і'], ['j', '', 'ј'],
  ['o', 'ο', 'о'], ['p', 'ρ', 'р'], ['s', '', 'ѕ'], ['v', 'ν', ''], ['x', 'χ', 'х'], ['y', 'γ', 'у'],
  ['', 'κ', 'к'], ['', 'π', 'п'], ['', 'τ', 'т'], ['', 'φ', 'ф'],
  ['A', 'Α', 'А'], ['B', 'Β', 'В'], ['C', '', 'С'], ['E', 'Ε', 'Е'], ['H', 'Η', 'Н'], ['I', 'Ι', 'І'],
  ['J', '', 'Ј'], ['K', 'Κ', 'К'], ['M', 'Μ', 'М'], ['N', 'Ν', ''], ['O', 'Ο', 'О'], ['P', 'Ρ', 'Р'],
  ['S', '', 'Ѕ'], ['T', 'Τ', 'Т'], ['X', 'Χ', 'Х'], ['Y', 'Υ', 'Ү'], ['Z', 'Ζ', ''],
];
const TWIN_SCRIPTS = ['Latin', 'Greek', 'Cyrillic'] as const;
type TwinScript = typeof TWIN_SCRIPTS[number];
const TWIN_ROW = new Map<string, readonly [string, string, string]>();
for (const row of CONFUSABLES) for (const ch of row) if (ch) TWIN_ROW.set(ch, row);

function twinScriptOf(ch: string): TwinScript | null {
  for (const s of TWIN_SCRIPTS) if (SCRIPT_RE.get(s)!.test(ch)) return s;
  return null;
}

// The run's letters in `target`, accents kept (a letter is decomposed and its
// base folded; the caller recomposes the line: Cyrillic о + acute → Greek ό),
// or null when any letter has no twin there.
function foldRun(run: string, target: TwinScript): string | null {
  const col = TWIN_SCRIPTS.indexOf(target);
  let out = '';
  for (const ch of run.normalize('NFD')) {
    if (MARK.test(ch)) { out += ch; continue; }
    const twin = TWIN_ROW.get(ch)?.[col];
    if (!twin) return null;
    out += twin;
  }
  return out;
}

// The character touching position `i` going `step` (-1 back, +1 on), past
// any combining mark; '' at the line's end. A space, digit or punctuation
// mark comes back as itself and is in no look-alike script.
function touchingChar(line: string, i: number, step: -1 | 1): string {
  const chars = step < 0 ? [...line.slice(0, i)].reverse() : [...line.slice(i)];
  return chars.find((ch) => !MARK.test(ch)) ?? '';
}

// A foreign run touching a letter of an allowed look-alike script with no
// space between (inside or at the edge of that word) folds to the first
// touching script, before then after, in which every one of its letters has a
// twin. A run standing alone ("но", "держ") or with a letter without a twin
// ("驱动", "держ") is a foreign word and is judged as one.
// The touching letter is always of an allowed script: every letter outside
// them is part of the run itself.
function homoglyphFold(line: string, run: string, start: number, end: number): string | null {
  for (const ch of [touchingChar(line, start, -1), touchingChar(line, end, 1)]) {
    const target = ch ? twinScriptOf(ch) : null;
    if (!target) continue;
    const folded = foldRun(run, target);
    if (folded) return folded;
  }
  return null;
}

// Mixed words. A word written in the speaker's own script with Latin letters
// glued into it, both scripts allowed, so no run above is foreign: a Greek
// line read «μεLANΧΟΛΙΑΣ», «λullabies», «τοsaved» (a space missing before the
// title “Saved”). Each such token (letters and marks, no space) mixing Latin
// with exactly one other allowed script is, in order:
//   (a) folded, when every letter of its minority script (strictly fewer
//       letters) has a twin in the majority script (the table above): «Hellο»
//       with a Greek omicron is "Hello";
//   (b) split, when it is one block of each script and the Latin block is a
//       word of a supplied name: «τοsaved» with “Saved” supplied is "το saved";
//   (c) otherwise a mixed word: a leak on speech (one regeneration, then the
//       drop), and left as written in a note, where taking it out would cut a
//       real word in half.
// A token a supplied name carries whole is never touched. Scripts written
// without spaces between words, or whose grammar glues particles onto a Latin
// name (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese, Tibetan), mix
// with Latin inside a token as a matter of course and are never judged here;
// nor is a Latin-only speaker, whose only script is Latin.
const UNSPACED_SCRIPTS: readonly ScriptName[] = ['Han', 'Hiragana', 'Katakana', 'Bopomofo', 'Hangul', 'Thai', 'Lao', 'Khmer', 'Myanmar', 'Tibetan'];
const TOKEN = /[\p{L}\p{M}]+/gu;

function letterScript(ch: string): ScriptName | null {
  for (const [name, re] of SCRIPT_RE) if (re.test(ch)) return name;
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface MixedScan { text: string; folds: ScriptFold[]; mixed: string[] }

function mixedTokens(line: string, allowed: Set<ScriptName>, supplied: readonly string[]): MixedScan {
  const own = [...allowed].filter((s) => s !== 'Latin' && !UNSPACED_SCRIPTS.includes(s));
  const result: MixedScan = { text: line, folds: [], mixed: [] };
  if (!own.length) return result;
  result.text = line.replace(TOKEN, (token) => {
    const scripts: Array<ScriptName | null> = [...token].map((ch) => (LETTER.test(ch) ? letterScript(ch) : null));
    const present = new Set(scripts.filter((s): s is ScriptName => s !== null));
    if (present.size !== 2 || !present.has('Latin')) return token;
    const other = [...present].find((s) => s !== 'Latin')!;
    if (!own.includes(other)) return token;
    const f = fold(token);
    if (supplied.some((n) => n.includes(f))) return token;
    const count = (s: ScriptName) => scripts.filter((x) => x === s).length;
    const latin = count('Latin');
    const native = count(other);
    // (a) the minority script's letters folded into the majority's.
    if (latin !== native) {
      const [minority, majority] = latin < native ? ['Latin', other] : [other, 'Latin'];
      if ((TWIN_SCRIPTS as readonly string[]).includes(majority)) {
        const target = majority as TwinScript;
        const chars = [...token];
        let ok = true;
        const out = chars.map((ch, i) => {
          if (scripts[i] !== minority) return ch;
          const twin = foldRun(ch, target);
          if (!twin) ok = false;
          return twin ?? ch;
        }).join('').normalize('NFC');
        if (ok) { result.folds.push({ from: token, to: out }); return out; }
      }
    }
    // (b) a missing space before or after a supplied name's Latin word.
    const blocks = token.match(new RegExp(`^(?:(\\p{Script=Latin}[\\p{M}]*)+|[^\\p{Script=Latin}]+)`, 'u'));
    const head = blocks?.[0] ?? '';
    const tail = token.slice(head.length);
    const tailOneScript = [...tail].every((ch) => !LETTER.test(ch) || (letterScript(ch) === 'Latin') === !/\p{Script=Latin}/u.test(head));
    if (head && tailOneScript) {
      const latinPart = fold(/\p{Script=Latin}/u.test(head) ? head : tail);
      const word = new RegExp(`(?:^|[^\\p{L}\\p{M}])${escapeRe(latinPart)}(?:$|[^\\p{L}\\p{M}])`, 'u');
      if (supplied.some((n) => word.test(n))) {
        const out = `${head} ${tail}`;
        result.folds.push({ from: token, to: out });
        return out;
      }
    }
    // (c) a mixed word.
    result.mixed.push(token);
    return token;
  });
  return result;
}

export interface ScriptScan {
  /** The foreign runs left once the look-alikes are folded, or null. */
  leak: ScriptLeak | null;
  /** The look-alike runs written back in their word's script. */
  folds: ScriptFold[];
  /** The line (NFC) with those folds applied. */
  text: string;
  /** Words mixing the speaker's script with Latin that no rule could mend. */
  mixed: string[];
}

/**
 * The whole judgement of one line: its look-alike runs folded into the script
 * of the word they sit in, and the foreign runs that remain and no supplied
 * name carries. Nothing is folded or reported when the guard cannot judge
 * (unknown language, or a line written mostly in the foreign script).
 */
export function scriptScan(
  text: unknown,
  { languages, names = [] }: { languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined; names?: readonly unknown[] },
): ScriptScan {
  const input = typeof text === 'string' ? text : '';
  const none: ScriptScan = { leak: null, folds: [], text: input, mixed: [] };
  const line = input.normalize('NFC');
  if (!line) return none;
  const allowed = allowedScripts(languages);
  if (!allowed) return none;
  const ok = allowedLetterRe(allowed);
  const runs: Array<{ run: string; start: number; end: number }> = [];
  let letters = 0;
  let run = '';
  let start = 0;
  let i = 0;
  for (const ch of line) {
    const at = i;
    i += ch.length;
    if (LETTER.test(ch)) {
      letters++;
      if (!ok.test(ch)) { if (!run) start = at; run += ch; continue; }
    } else if (run && MARK.test(ch)) {
      run += ch;
      continue;
    }
    if (run) { runs.push({ run, start, end: at }); run = ''; }
  }
  if (run) runs.push({ run, start, end: line.length });
  const supplied = names.map(fold).filter(Boolean);
  const leaked: string[] = [];
  const folds: Array<{ from: string; to: string; start: number; end: number }> = [];
  let exemptLetters = 0;
  for (const r of runs) {
    const f = fold(r.run);
    if (supplied.some((n) => n.includes(f))) { exemptLetters += letterCount(r.run); continue; }
    const to = homoglyphFold(line, r.run, r.start, r.end);
    if (to) folds.push({ from: r.run, to, start: r.start, end: r.end });
    else leaked.push(r.run);
  }
  const leakedLetters = leaked.reduce((n, r) => n + letterCount(r), 0);
  // Mostly foreign: the line is in that script, not carrying a stray word of it.
  if (leakedLetters * 2 > letters - exemptLetters) return none;
  let out = line;
  for (const f of [...folds].reverse()) out = out.slice(0, f.start) + f.to + out.slice(f.end);
  const mended = mixedTokens(out.normalize('NFC'), allowed, supplied);
  const all = [...folds.map(({ from, to }) => ({ from, to })), ...mended.folds];
  const seen = new Set<string>();
  const uniqueFolds = all.filter((f) => !seen.has(`${f.from}\u0000${f.to}`) && seen.add(`${f.from}\u0000${f.to}`));
  const mixedWords = [...new Set(mended.mixed)];
  if (!leaked.length) return { leak: null, folds: uniqueFolds, text: mended.text, mixed: mixedWords };
  const unique = [...new Set(leaked)];
  return { leak: { runs: unique, scripts: [...new Set(unique.map(scriptOf))] }, folds: uniqueFolds, text: mended.text, mixed: mixedWords };
}

/**
 * The foreign-script runs in `text` that no supplied name carries, or null
 * when there is none (or the guard cannot judge: unknown language, or a line
 * written mostly in the foreign script). A look-alike run folded into its
 * word's script is no leak (scriptScan).
 */
export function scriptLeak(
  text: unknown,
  opts: { languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined; names?: readonly unknown[] },
): ScriptLeak | null {
  return scriptScan(text, opts).leak;
}

// A note left with fewer letters than this says nothing worth keeping.
const NOTE_MIN_LETTERS = 12;

/**
 * The foreign runs taken out of a note, and the spacing tidied: a run glued
 * between two words leaves a space, never a merged word ("BPM驱动βήμα" →
 * "BPM βήμα"), and no space is left before punctuation or doubled.
 */
export function withoutLeakedRuns(text: string, runs: readonly string[]): string {
  let out = text.normalize('NFC');
  for (const run of [...runs].sort((a, b) => b.length - a.length)) out = out.split(run).join(' ');
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?。，،؟])/g, '$1')
    .replace(/([(\[«“]) +/g, '$1')
    .replace(/(^|\s)[,;:]+(?=\s|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Fullwidth and ideographic punctuation. A leaked Chinese or Japanese run
// brings its punctuation along, and taking the letters out leaves it behind:
// "124bpm/10B，driving night instrumental，fresh，." Those marks are Common
// script, so the guard never counts them; in a line the guard rewrites (a run
// stripped or a look-alike folded) they become their ASCII forms, for a
// speaker whose languages do not write them. A speaker of Chinese, Japanese or
// Korean keeps them as written.
const CJK_PUNCTUATION_SCRIPTS: readonly ScriptName[] = ['Han', 'Hiragana', 'Katakana', 'Bopomofo', 'Hangul'];
const WIDE_PUNCTUATION = /[\u3000-\u303F\uFF00-\uFFEF]/gu;
const WIDE_KIND = /[\p{P}\p{S}\p{Zs}]/u;
// Keyed on the NFKC form, which already narrows the fullwidth ASCII marks
// (，→ ,), so only the ideographic ones are listed by themselves.
const ASCII_OF: Record<string, string> = {
  ',': ', ', '、': ', ', '.': '. ', '。': '. ', ';': '; ', ':': ': ', '!': '! ', '?': '? ',
  '(': ' (', ')': ') ', '「': ' “', '」': '” ', '『': ' “', '』': '” ',
  '《': ' “', '》': '” ', '〈': ' “', '〉': '” ', '【': ' [', '】': '] ', '〔': ' [', '〕': '] ', '〖': ' [', '〗': '] ',
  '[': ' [', ']': '] ', '〜': '~', ' ': ' ',
};

/**
 * `text` with fullwidth and ideographic punctuation in its ASCII form, and the
 * separators a removed run leaves behind collapsed (doubled spaces and
 * commas, a comma before a full stop, a dangling one at either end). Words
 * are never touched. Unchanged for a speaker who writes Chinese, Japanese or
 * Korean (or when the language is unknown).
 */
export function withAsciiPunctuation(text: string, languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined): string {
  const allowed = allowedScripts(languages);
  if (!allowed || CJK_PUNCTUATION_SCRIPTS.some((s) => allowed.has(s))) return text;
  return text
    .replace(WIDE_PUNCTUATION, (ch) => {
      if (!WIDE_KIND.test(ch)) return ch;
      const narrow = ch.normalize('NFKC');
      return ASCII_OF[narrow] ?? (/^[\x21-\x7e]$/.test(narrow) ? narrow : ch);
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?)\]”])/g, '$1')
    .replace(/([(\[“])[ \t]+/g, '$1')
    .replace(/([,;:])(?:[ \t]*[,;:])+/g, '$1')
    .replace(/[,;:][ \t]*([.!?])/g, '$1')
    .replace(/^[ \t]*[,;:]+/, '')
    .replace(/[ \t,;:]+$/, '')
    .trim();
}

export type ScriptLeakSurface = 'speech' | 'note';

export type ScriptLeakVerdict =
  | { action: 'keep' }
  /** Only look-alike letters: the line with them folded goes on, on any surface. */
  | { action: 'fold'; folds: ScriptFold[]; text: string }
  /** Speech whose writer may still retry: generate it again, once. */
  | { action: 'regenerate'; leak: ScriptLeak; folds: ScriptFold[] }
  /** Speech with no retry left: the line does not air. */
  | { action: 'drop'; leak: ScriptLeak; folds: ScriptFold[] }
  /** A note: the foreign runs removed (look-alikes folded), the rest kept. */
  | { action: 'strip'; leak: ScriptLeak; folds: ScriptFold[]; text: string }
  /** A note with too little left once they are out: use the plain credit. */
  | { action: 'plain'; leak: ScriptLeak; folds: ScriptFold[] };

/**
 * What a line's foreign letters cost on `surface`. Look-alikes alone are no
 * leak anywhere: `fold`, the word written back in its own script, so a spoken
 * line goes on air fixed instead of being retried or dropped. A real foreign
 * run on speech: `regenerate` while `retry` is allowed, else `drop`. On a
 * note: `strip`, or `plain` when fewer than a dozen letters would remain. A
 * line rewritten here (`fold`, `strip`) also has its stray fullwidth
 * punctuation made ASCII (withAsciiPunctuation); a kept line is untouched.
 */
export function scriptLeakVerdict(
  text: unknown,
  { languages, names = [], surface, retry = false }: {
    languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined;
    names?: readonly unknown[];
    surface: ScriptLeakSurface;
    retry?: boolean;
  },
): ScriptLeakVerdict {
  const { leak, folds, text: folded, mixed } = scriptScan(text, { languages, names });
  if (surface === 'speech' && (leak || mixed.length)) {
    // A mixed word reads as noise too: it is judged with the foreign runs.
    const runs = [...(leak?.runs ?? []), ...mixed];
    const scripts = [...new Set([...(leak?.scripts ?? []), ...(mixed.length ? ['Mixed'] : [])])];
    const all = { runs, scripts };
    return retry ? { action: 'regenerate', leak: all, folds } : { action: 'drop', leak: all, folds };
  }
  // A note keeps a mixed word as written: only foreign runs come out of it.
  if (!leak) return folds.length ? { action: 'fold', folds, text: withAsciiPunctuation(folded, languages) } : { action: 'keep' };
  const stripped = withAsciiPunctuation(withoutLeakedRuns(folded, leak.runs), languages);
  return letterCount(stripped) >= NOTE_MIN_LETTERS ? { action: 'strip', leak, folds, text: stripped } : { action: 'plain', leak, folds };
}
