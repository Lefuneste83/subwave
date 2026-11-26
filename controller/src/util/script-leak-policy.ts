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

/**
 * The foreign-script runs in `text` that no supplied name carries, or null
 * when there is none (or the guard cannot judge: unknown language, or a line
 * written mostly in the foreign script).
 */
export function scriptLeak(
  text: unknown,
  { languages, names = [] }: { languages: { primary?: unknown; mix?: readonly unknown[] } | null | undefined; names?: readonly unknown[] },
): ScriptLeak | null {
  const line = typeof text === 'string' ? text.normalize('NFC') : '';
  if (!line) return null;
  const allowed = allowedScripts(languages);
  if (!allowed) return null;
  const ok = allowedLetterRe(allowed);
  const runs: string[] = [];
  let letters = 0;
  let run = '';
  for (const ch of line) {
    if (LETTER.test(ch)) {
      letters++;
      if (!ok.test(ch)) { run += ch; continue; }
    } else if (run && MARK.test(ch)) {
      run += ch;
      continue;
    }
    if (run) { runs.push(run); run = ''; }
  }
  if (run) runs.push(run);
  if (!runs.length) return null;
  const supplied = names.map(fold).filter(Boolean);
  const leaked: string[] = [];
  let exemptLetters = 0;
  for (const r of runs) {
    const f = fold(r);
    if (supplied.some((n) => n.includes(f))) exemptLetters += letterCount(r);
    else leaked.push(r);
  }
  if (!leaked.length) return null;
  const leakedLetters = leaked.reduce((n, r) => n + letterCount(r), 0);
  // Mostly foreign: the line is in that script, not carrying a stray word of it.
  if (leakedLetters * 2 > letters - exemptLetters) return null;
  const unique = [...new Set(leaked)];
  return { runs: unique, scripts: [...new Set(unique.map(scriptOf))] };
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

export type ScriptLeakSurface = 'speech' | 'note';

export type ScriptLeakVerdict =
  | { action: 'keep' }
  /** Speech whose writer may still retry: generate it again, once. */
  | { action: 'regenerate'; leak: ScriptLeak }
  /** Speech with no retry left: the line does not air. */
  | { action: 'drop'; leak: ScriptLeak }
  /** A note: the foreign runs removed, the rest kept. */
  | { action: 'strip'; leak: ScriptLeak; text: string }
  /** A note with too little left once they are out: use the plain credit. */
  | { action: 'plain'; leak: ScriptLeak };

/**
 * What a leak costs on `surface`. Speech: `regenerate` while `retry` is
 * allowed, else `drop`. A note: `strip`, or `plain` when fewer than a dozen
 * letters would remain.
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
  const leak = scriptLeak(text, { languages, names });
  if (!leak) return { action: 'keep' };
  if (surface === 'speech') return retry ? { action: 'regenerate', leak } : { action: 'drop', leak };
  const stripped = withoutLeakedRuns(String(text), leak.runs);
  return letterCount(stripped) >= NOTE_MIN_LETTERS ? { action: 'strip', leak, text: stripped } : { action: 'plain', leak };
}
