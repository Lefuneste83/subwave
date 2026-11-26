import assert from 'node:assert/strict';
import { cjkUnsafeForSpokenLanguage, cjkWrittenLanguage, scrubCjkForSpeech } from '../src/audio/spoken-script-policy.js';

assert.equal(cjkUnsafeForSpokenLanguage(''), true, 'unset persona language follows the English default');
assert.equal(cjkUnsafeForSpokenLanguage('English'), true, 'English is protected');
assert.equal(cjkUnsafeForSpokenLanguage('English (UK)'), true, 'an English locale label is protected');
assert.equal(cjkUnsafeForSpokenLanguage('Japanese'), false, 'a Japanese persona keeps its native script');
assert.equal(cjkUnsafeForSpokenLanguage('Mandarin Chinese'), false, 'a Chinese persona keeps its native script');

assert.equal(
  scrubCjkForSpeech('Ulfuls bring the daylight with ガッツだぜ!!', 'English'),
  'Ulfuls bring the daylight!',
  'a residual Japanese title cannot reach English TTS',
);
assert.equal(
  scrubCjkForSpeech('Hikaru Utada with Hana束 wo Kimi ni.', ''),
  'Hikaru Utada with Hana wo Kimi ni.',
  'one leaked kanji is removed without discarding the model romanization',
);
assert.equal(
  scrubCjkForSpeech('稻香 by Jay Chou — still holding.', 'English'),
  'by Jay Chou — still holding.',
  'a native title is dropped while the canonical artist name survives',
);
assert.equal(
  scrubCjkForSpeech('宇多田ヒカルの「花束を君に」です。', 'Japanese'),
  '宇多田ヒカルの「花束を君に」です。',
  'native-language speech remains byte-identical',
);
assert.equal(
  scrubCjkForSpeech('Björk and Rosalía — unchanged.', 'English'),
  'Björk and Rosalía — unchanged.',
  'Latin-script names and accents remain untouched',
);
assert.equal(cjkUnsafeForSpokenLanguage('', ['English (UK)']), true, 'an all-English mix is still protected');
assert.equal(
  scrubCjkForSpeech('Next up, ウルフルズ — やばい tune, ね。', 'English', ['Japanese']),
  'Next up, ウルフルズ — やばい tune, ね。',
  'a multilingual persona keeps the script it mixes in',
);

// The scrub stands down only for a mix language written in CJK script.
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Spanish']), true, 'English + Spanish keeps the CJK net');
assert.equal(
  scrubCjkForSpeech('Next up, ウルフルズ — vamos.', 'English', ['Spanish']),
  'Next up, — vamos.',
  'English + Spanish on an English voice still loses leaked kana',
);
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Spanish', 'Korean']), false, 'one CJK language in the mix stands it down');
assert.equal(cjkUnsafeForSpokenLanguage('English', ['日本語']), false, 'a native-script language name counts');
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Chinese (Traditional)']), false, 'a labelled Chinese counts');

// Any language not itself written in CJK is protected, English or not: a Greek
// programme feature aired "την自身 του" with the stray kanji read out.
assert.equal(cjkUnsafeForSpokenLanguage('French', ['Spanish']), true, 'a non-English, non-CJK primary keeps the net, mix or not');
for (const lang of ['Greek', 'French', 'Ελληνικά', 'Russian', 'Hindi', 'el', 'fr-FR']) {
  assert.equal(cjkUnsafeForSpokenLanguage(lang), true, `${lang} is protected`);
}
assert.equal(
  scrubCjkForSpeech('Χάθηκε από τη ραφιέρα, λες και φοβήθηκε την自身 του τη βαριά σκιά.', 'Greek'),
  'Χάθηκε από τη ραφιέρα, λες και φοβήθηκε την του τη βαριά σκιά.',
  'a stray kanji run inside a Greek line is dropped, the Greek words stay',
);
// Glued inside a word on both sides, the run leaves a non-word, so the word goes.
assert.equal(
  scrubCjkForSpeech('Το Méridiens του Chapelier Fou το捕捉ει αυτή τη στιγμή.', 'Greek'),
  'Το Méridiens του Chapelier Fou αυτή τη στιγμή.',
  'a word split by a kanji run goes whole',
);
assert.equal(
  scrubCjkForSpeech('Πριν σβήσουν οι最后ες ακτίνες.', 'Greek'),
  'Πριν σβήσουν ακτίνες.',
  'a word split by a kanji run goes whole',
);
assert.equal(
  scrubCjkForSpeech('Μόλις过了七 η μουσική χορεύει.', 'Greek'),
  'Μόλις η μουσική χορεύει.',
  'a run touching a word on one side only goes alone',
);
assert.equal(
  scrubCjkForSpeech('Voici 稻香, de Jay Chou.', 'French'),
  'Voici, de Jay Chou.',
  'a native title inside a French line is dropped like an English one',
);
assert.equal(
  scrubCjkForSpeech('Πάμε με τον «Sundowner».', 'Greek'),
  'Πάμε με τον «Sundowner».',
  'a Greek line with no CJK is byte-identical',
);
assert.equal(
  scrubCjkForSpeech('Next up, ウルフルズ — vamos.', 'Greek', ['Japanese']),
  'Next up, ウルフルズ — vamos.',
  'a non-English persona that also speaks a CJK language keeps that script',
);
for (const lang of ['Japanese', 'zh-TW', 'Korean', '中文']) {
  assert.equal(cjkUnsafeForSpokenLanguage(lang), false, `${lang} keeps its own script`);
  assert.equal(
    scrubCjkForSpeech('宇多田ヒカルの「花束を君に」です。', lang),
    '宇多田ヒカルの「花束を君に」です。',
    `${lang} speech stays byte-identical`,
  );
}
// A CJK-written language under a name this module does not know (a 639-3 code)
// is not erased: a line that is mostly CJK is that persona's own script.
assert.equal(
  scrubCjkForSpeech('宇多田ヒカルの「花束を君に」です。', 'jpn'),
  '宇多田ヒカルの「花束を君に」です。',
  'a mostly-CJK line under an unrecognised language name survives',
);
assert.equal(
  scrubCjkForSpeech('Ulfuls bring the daylight with ガッツだぜ!!', 'English'),
  'Ulfuls bring the daylight!',
  'English keeps the old rule',
);
assert.equal(
  scrubCjkForSpeech('ガッツだぜ ガッツだぜ ok', 'English'),
  'ok',
  'an English line is scrubbed however much CJK it holds',
);

// A CJK language named anywhere as a whole word, or a whole-entry code.
for (const lang of [
  'Japanese', 'Korean', 'Cantonese', 'Chinese (Traditional)', '日本語', 'Japanese_JP', 'korean-seoul',
  'Traditional Chinese', 'Simplified Chinese', 'Mandarin Chinese', 'Taiwanese Mandarin',
  'zh', 'ja', 'ko', 'ZH', 'zh-CN', 'zh-TW', 'zh-Hant', 'zh_Hans_CN', 'ja-JP', 'ko-KR',
]) {
  assert.equal(cjkWrittenLanguage(lang), true, `${lang} is CJK-written`);
  assert.equal(cjkUnsafeForSpokenLanguage('English', [lang]), false, `English + ${lang} keeps its script`);
}
for (const lang of [
  'Vietnamese', 'Hindi', 'Thai', 'Spanish', 'Klingon', 'Japanes', 'Koreanish',
  'jazz', 'kongo', 'zhuang', 'Japan-ish', 'en', 'es-ES', 'vi', 'th', 'hi',
]) {
  assert.equal(cjkWrittenLanguage(lang), false, `${lang} is not CJK-written`);
  assert.equal(cjkUnsafeForSpokenLanguage('English', [lang]), true, `English + ${lang} keeps the scrub`);
}

console.log('spoken-script-policy.test.ts: all assertions passed');
