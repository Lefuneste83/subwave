// Final script boundary for booth-bound speech. A voice reads leaked CJK
// codepoints as literal character classes ("Japanese letter") or as noise, so
// this fails safe when generation did not. A scrub, not a transliterator: the
// model owns the canonical spelling. A dropped run takes nothing else with it.
//
// Judged by the persona's languages, never by its script: any language that
// is not itself written in CJK is protected (a Greek or French line carried a
// stray "自身" mid-sentence just as an English one can). A multilingual
// persona (`alsoSpeaks`) is judged by its primary language, and the scrub
// stands down only when a language it speaks is itself WRITTEN in CJK script:
// English + Japanese keeps its kana, but English + Spanish on a local English
// voice is still protected. Matched by name (English or native), so an
// unrecognised mix language keeps the safety net rather than dropping it. A
// primary language this module does not recognise as CJK-written still keeps a
// line that is mostly CJK: such a line is the persona's own script, and erasing
// it would leave nothing to say. English keeps the old rule, unconditionally.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const ENGLISH_RE = /^english(?:\b|\s|[-_(])/i;
// A CJK language named anywhere in the entry, as a whole word ("Traditional
// Chinese", "Mandarin Chinese"), or a whole-entry code with an optional region
// or script subtag (`zh`, `zh-TW`, `zh-Hant`, `ja-JP`, `ko_KR`). No misspellings.
const CJK_LANGUAGE_RE = /(?<![a-z])(?:japanese|nihongo|chinese|mandarin|cantonese|putonghua|taiwanese|hokkien|hakka|shanghainese|korean|hangugeo)(?![a-z])/i;
const CJK_CODE_RE = /^(?:zh|ja|ko)(?:[-_][a-z0-9]{2,8})*$/i;
const CJK_NAME_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function cjkWrittenLanguage(language: unknown): boolean {
  const lang = String(language || '').trim();
  return CJK_LANGUAGE_RE.test(lang) || CJK_CODE_RE.test(lang) || CJK_NAME_RE.test(lang);
}

// An unset persona language is the product's long-standing English default.
function englishPrimary(language: unknown): boolean {
  const lang = String(language || '').trim();
  return !lang || ENGLISH_RE.test(lang);
}

export function cjkUnsafeForSpokenLanguage(language: unknown, mix: readonly unknown[] = []): boolean {
  if (mix.some(cjkWrittenLanguage)) return false;
  return englishPrimary(language) || !cjkWrittenLanguage(language);
}

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const GLUED_CJK_RE = new RegExp(`[^${CJK_CLASS}][${CJK_CLASS}]+[^${CJK_CLASS}]`, 'u');

// Letters in CJK script against all letters: above half, the line is written
// in CJK, whatever the persona's language field calls it.
const CJK_LETTER_RE = new RegExp(CJK_NAME_RE.source, 'gu');
function mostlyCjk(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const cjk = text.match(CJK_LETTER_RE)?.length ?? 0;
  return letters > 0 && cjk * 2 > letters;
}

export function scrubCjkForSpeech(text: string, language: unknown, mix: readonly unknown[] = []): string {
  if (!text || !cjkUnsafeForSpokenLanguage(language, mix) || !CJK_RE.test(text)) return text;
  CJK_RE.lastIndex = 0;
  let out = text;
  if (!englishPrimary(language)) {
    if (mostlyCjk(text)) return text;
    // A run glued inside another script's word on both sides leaves a non-word
    // behind ("το捕捉ει" → "τοει"), so that word goes whole.
    out = out.replace(/[\p{L}\p{M}\p{N}]+/gu, (word) => (GLUED_CJK_RE.test(word) ? '' : word));
  }
  return out
    .replace(CJK_RE, '')
    .replace(/\b(?:with|by)\s*([,.;:!?])/gi, '$1')
    .replace(/([!?])\1+/g, '$1')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
