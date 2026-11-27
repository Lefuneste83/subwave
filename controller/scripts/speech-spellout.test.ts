// Years and whole numbers spelled in the speaker's own language from Unicode
// CLDR's spell-out rules (audio/spellout.ts), applied by normalizeForSpeech to
// every language but English, which keeps its own verbaliser.
// Run: npm test -- speech-spellout
//
// The golden table (fixtures/rbnf-icu-golden.json) is ICU4C 79.1's own
// RuleBasedNumberFormat output over the same CLDR 49 rule files the vendored
// data was cut from: years 1900–2030 by %spellout-numbering-year and 0–100,
// 1000, 2000 and 1000000 by %spellout-numbering, for nine languages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeForDisplay, normalizeForSpeech } from '../src/audio/speech-text.js';
import { formatWithRules, parseRules, spellOut, spelloutLocale } from '../src/audio/spellout.js';
import { languageLocale } from '../src/util/language-locale.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/rbnf-icu-golden.json', import.meta.url), 'utf8')) as {
  years: [number, number];
  numbers: number[];
  locales: Record<string, { year: string[]; number: string[] }>;
};

for (const [locale, want] of Object.entries(golden.locales)) {
  test(`${locale} spells years and numbers exactly as ICU does`, () => {
    const [from, to] = golden.years;
    const years = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    assert.deepEqual(years.map((y) => spellOut(locale, y, 'year')), want.year);
    assert.deepEqual(golden.numbers.map((n) => spellOut(locale, n, 'number')), want.number);
  });
}

test('the golden table covers the nine languages it promises', () => {
  assert.deepEqual(Object.keys(golden.locales).sort(), ['de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pt', 'ru']);
});

// Hand-made rule texts for the RBNF corners the CLDR table reaches only in a
// few languages: the [a|b] alternative, the roll-back for an even multiple,
// the >>> predecessor rule, a plural $(…)$ and a decimal pattern.
test('the interpreter follows the RBNF rule forms ICU defines', () => {
  const sets = parseRules([
    '%main:',
    '0: zero;',
    '1: one;',
    '2: two;',
    '3: three;',
    '10: ten;',
    '20: twenty[->>];',
    '100: << hundred[ >>|s];',
    '1000: << $(cardinal,one{thousand}other{thousands})$[ >>];',
    '1000000: =#,##0=;',
    '%tail:',
    '0: z;',
    '1: o;',
    '2: t;',
    '5: f>>;',
    '10: <<>>>;',
  ].join('\n'));
  const say = (n: number, set = '%main') => formatWithRules(sets, 'en', set, n);
  assert.equal(say(20), 'twenty');
  assert.equal(say(22), 'twenty-two');
  assert.equal(say(200), 'two hundreds');
  assert.equal(say(201), 'two hundred one');
  assert.equal(say(1000), 'one thousand');
  assert.equal(say(3020), 'three thousands twenty');
  assert.equal(say(1_234_567), '1,234,567');
  // >>> formats the remainder with the rule before it (5: f>>), no search.
  assert.equal(say(13, '%tail'), 'ofz');
});

test('Greek years are said in Greek, with the soft hyphen of the rules taken out', () => {
  const greek = (text: string) => normalizeForSpeech(text, [], 'Greek');
  assert.equal(greek('Κυκλοφόρησε το 1991.'), 'Κυκλοφόρησε το χίλια εννιακόσια ενενήντα ένα.');
  assert.equal(greek('Ξανά το 2021.'), 'Ξανά το δύο χιλιάδες είκοσι ένα.');
  assert.equal(greek('Από το 1985'), 'Από το χίλια εννιακόσια ογδόντα πέντε');
  assert.equal(greek('ως το 2013'), 'ως το δύο χιλιάδες δεκατρία');
  assert.equal(greek('12 κομμάτια'), 'δώδεκα κομμάτια');
});

test('the persona language is recognised by English name, native name and code', () => {
  const want = 'το χίλια εννιακόσια ενενήντα έξι';
  for (const language of ['Greek', 'greek', 'Ελληνικά', 'el', 'ell', 'el-GR', 'el_GR', ' Greek ']) {
    assert.equal(normalizeForSpeech('το 1996', [], language), want, language);
  }
  assert.equal(languageLocale('Brazilian Portuguese'), 'pt');
  assert.equal(languageLocale('pt_BR'), 'pt-BR');
  assert.equal(languageLocale('gre'), 'el');
  assert.equal(languageLocale('Marathi'), 'mr');
  assert.equal(languageLocale('Cantonese'), 'yue');
  assert.equal(languageLocale('Klingon'), null);
  assert.equal(spelloutLocale('pt-BR'), 'pt');
  assert.equal(spelloutLocale('pt-PT'), 'pt-PT');
  assert.equal(spelloutLocale('zh-TW'), 'zh-Hant');
  assert.equal(spelloutLocale('nb'), 'no');
  assert.equal(spelloutLocale('eu'), null);
});

test('other languages use their own rules: the year set for a year, the numbering set for a count', () => {
  assert.equal(normalizeForSpeech('Sorti en 1967, 1967 ms plus tard.', [], 'French'),
    'Sorti en dix-neuf-cent soixante-sept, mille neuf cent soixante-sept ms plus tard.');
  assert.equal(normalizeForSpeech('Erschienen 1991, Platz 21.', [], 'German'),
    'Erschienen neunzehnhunderteinundneunzig, Platz einundzwanzig.');
  assert.equal(normalizeForSpeech('Альбом 1991 года, 5 песен.', [], 'Russian'),
    'Альбом тысяча девятьсот девяносто первого года, пять песен.');
  assert.equal(normalizeForSpeech('Salió en 2021.', [], 'es'), 'Salió en dos mil veintiuno.');
});

test('year ranges are spelled on both ends, decades in English form stay', () => {
  assert.equal(normalizeForSpeech('1991–1995', [], 'Greek'),
    'χίλια εννιακόσια ενενήντα ένα - χίλια εννιακόσια ενενήντα πέντε');
  assert.equal(normalizeForSpeech('1965-75', [], 'Greek'),
    'χίλια εννιακόσια εξήντα πέντε - εβδομήντα πέντε');
  assert.equal(normalizeForSpeech("τα 1980s και τα '80s", [], 'Greek'), "τα 1980s και τα '80s");
});

test('digits inside a name the line carries stay digits', () => {
  const names = ['Top 100', 'Vol. 08', '10101', 'Hits - 1983 -', 'Stereo 2000'];
  assert.equal(
    normalizeForSpeech('Το Top 100, το Vol. 08, το 10101 και το Hits 1983, από το 1983.', [], 'Greek', '', names),
    'Το Top 100, το Vol. 08, το 10101 και το Hits 1983, από το χίλια εννιακόσια ογδόντα τρία.',
  );
  assert.equal(normalizeForSpeech('Hits - 1983 - και stereo 2000', [], 'Greek', '', names), 'Hits - 1983 - και stereo 2000');
  // The same digits with no name to protect them are spelled.
  assert.equal(normalizeForSpeech('Top 100', [], 'Greek'), 'Top εκατό');
});

test('numbers that are not a plain count keep their digits', () => {
  const greek = (text: string) => normalizeForSpeech(text, [], 'Greek');
  assert.equal(greek('στις 20:30'), 'στις 20:30');
  assert.equal(greek('3,5 βαθμοί και 2.5'), '3,5 βαθμοί και 2.5');
  assert.equal(greek('27/11/2026'), '27/11/2026');
  assert.equal(greek('No. 5 και #3'), 'No. 5 και #3');
  assert.equal(greek('η 3η θέση, ο 2pac'), 'η 3η θέση, ο 2pac');
  assert.equal(greek('το 08 και 1234567890'), 'το 08 και 1234567890');
  // Left for the unit rules after this pass, which key on a digit.
  assert.equal(greek('50% και 20°C και ₹1967 και $5'), '50 percent και 20 degrees Celsius και ₹1967 και 5 dollars');
});

test('an operator correction still comes first', () => {
  assert.equal(normalizeForSpeech('Sorti en **1967**.', [{ from: '1967', to: 'soixante-sept' }], 'French'),
    'Sorti en soixante-sept.');
});

test('display text keeps the digits the model wrote', () => {
  assert.equal(normalizeForDisplay('Κυκλοφόρησε το 1991.'), 'Κυκλοφόρησε το 1991.');
});

test('English keeps its own verbaliser, and an English label it never matched keeps digits', () => {
  for (const language of ['', 'English', 'en-GB']) {
    assert.equal(normalizeForSpeech('Released in 1991, 5 tracks.', [], language), 'Released in nineteen ninety-one, 5 tracks.');
  }
  // Native names of English were never the English path; still untouched.
  assert.equal(normalizeForSpeech('Released in 1991, 5 tracks.', [], 'Inglés'), 'Released in 1991, 5 tracks.');
});

test('a language without CLDR rules, or one not recognised, keeps the line byte-identical', () => {
  const text = "1967, 1960s, '60s and 1967-1972, 12 tracks";
  for (const language of ['Klingon', 'unknown', 'xx', 'tlh', 'Basque', 'eu']) {
    assert.equal(normalizeForSpeech(text, undefined, language), text, language);
  }
});
