// A model-written line that carries a word from a writing system its
// speaker's language does not use (a Greek pick note "124 BPM驱动βήμα", a Greek
// link "τηνAA自身 του") never reaches the air or the Booth. The rule is
// util/script-leak-policy.ts, for every language its table knows; these pin it
// across languages, then the three places it acts: the free-text writer
// regenerates once (llm djText `speaker`), the speech gate drops what still
// leaks like a stand-in (queue.speakable, push, the pick link trim), and a pick
// note, which is read and never aired, loses only the stray runs, falling back
// to the route's plain credit only when too little is left (pick-note.ts).
// The severity split is the policy's own verdict (scriptLeakVerdict). A
// look-alike letter inside a word of the speaker's script (a Cyrillic а in a
// Greek word) is folded back, not cut, and a word gluing the speaker's script
// to Latin is mended when it can be and judged when it cannot.
//
// The only mocked component for the writer is the OpenAI-compatible HTTP
// boundary. Run: npm test -- script-leak-guard

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatCompletionResponse } from './test-utils/llm.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-script-leak-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { scriptLeak, scriptLeakVerdict, withoutLeakedRuns, withAsciiPunctuation, languageScripts, allowedScripts } = await import('../src/util/script-leak-policy.js');
const { trimLinkToIntro } = await import('../src/broadcast/dj-agent/enqueue.js');
const { groundPickNote } = await import('../src/broadcast/dj-agent/pick-note.js');
const { agenticDiscoverySelectionReason } = await import('../src/broadcast/dj-agent/leanings-review.js');
const { shortlistClauseSelectionReason } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const { generateStationId } = await import('../src/llm/internal/prompts/scripts.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

const lang = (primary: string, mix: string[] = []) => ({ languages: { primary, mix } });
const leakOf = (text: string, primary: string, names: unknown[] = [], mix: string[] = []) =>
  scriptLeak(text, { ...lang(primary, mix), names });

// ── the policy ───────────────────────────────────────────────────────────────

test('the leaks seen on a Greek station are caught, with their letters', () => {
  const cases: Array<[string, string[], string]> = [
    ['124 BPM驱动βήμα', ['驱动'], 'Han'],
    ['ζεστά电子τικά', ['电子'], 'Han'],
    ["4A延续 1A's", ['延续'], 'Han'],
    ['μελαγχολικό αλλά όχι βαρύ, но σκοτεινό', ['но'], 'Cyrillic'],
    ['η πόλη στην AA自身 της ένταση', ['自身'], 'Han'],
  ];
  for (const [text, runs, script] of cases) {
    const leak = leakOf(text, 'Greek');
    assert.ok(leak, text);
    assert.deepEqual(leak.runs, runs, text);
    assert.deepEqual(leak.scripts, [script], text);
  }
});

test('a line in the speaker\'s own scripts is no leak, Latin included', () => {
  assert.equal(leakOf('Συνεχίζουμε με Kruder & Dorfmeister, 124 BPM σε 8A — ζεστό και αργό.', 'Greek'), null);
  assert.equal(leakOf('That was Porcelain by Moby, 96 BPM in 4A.', 'English'), null);
  assert.equal(leakOf('Дальше — Kino, «Группа крови».', 'Russian'), null);
  assert.equal(leakOf('次はウルフルズの曲です。Enjoy!', 'Japanese'), null);
  assert.equal(leakOf('接下来是一首很温柔的歌。', 'Chinese'), null);
  assert.equal(leakOf('다음 곡은 정말 좋은 노래입니다 (音樂).', 'Korean'), null);
  assert.equal(leakOf('والآن أغنية هادئة من Fairuz.', 'Arabic'), null);
});

test('a foreign word in an English, Russian, Japanese, Chinese or Arabic line is a leak', () => {
  assert.deepEqual(leakOf('Next up a slow one 自身 for the evening crowd.', 'English')?.runs, ['自身']);
  assert.deepEqual(leakOf('A warm groove, σκοτεινό and slow, for the late hour.', 'English')?.runs, ['σκοτεινό']);
  assert.deepEqual(leakOf('Дальше очень тёплая песня 驱动 для вечера.', 'Russian')?.runs, ['驱动']);
  assert.deepEqual(leakOf('Дальше очень тёплая песня και для вечера.', 'Russian')?.runs, ['και']);
  assert.deepEqual(leakOf('次はとても静かな曲です、그리고 夜にぴったりです。', 'Japanese')?.runs, ['그리고']);
  assert.deepEqual(leakOf('次はとても静かな曲です、очень 夜にぴったりです。', 'ja-JP')?.runs, ['очень']);
  assert.deepEqual(leakOf('接下来是一首很温柔的歌、とても好きです。', 'Mandarin Chinese')?.scripts, ['Hiragana']);
  assert.deepEqual(leakOf('والآن أغنية هادئة جدا للمساء но من Fairuz.', 'Arabic')?.runs, ['но']);
});

test('a name supplied in another script is carried, not leaked', () => {
  // A Japanese artist in a Greek line, a Greek album title in an English one.
  assert.equal(leakOf('Τώρα ακούμε τους ウルフルズ, ζεστά και δυνατά.', 'Greek', ['ウルフルズ']), null);
  assert.equal(leakOf('From the album Θάλασσα, a slow one for the evening.', 'English', ['Θάλασσα']), null);
  assert.equal(leakOf('From the album ΘΆΛΑΣΣΑ, a slow one.', 'English', ['θάλασσα']), null, 'case-folded');
  // Part of a supplied name is still the name.
  assert.equal(leakOf('Ένα κομμάτι από το 東京 album, απόψε.', 'Greek', ['東京事変']), null);
  // A name does not excuse a different stray word beside it.
  assert.deepEqual(leakOf('Τώρα οι ウルフルズ, 自身 δυνατά και ζεστά απόψε.', 'Greek', ['ウルフルズ'])?.runs, ['自身']);
});

test('digits, punctuation, symbols and emoji are not letters and never leak', () => {
  assert.equal(leakOf('124 BPM — 8A → 9A ♪ 🎶 «…» ¿? №1 ½ ©', 'English'), null);
  assert.equal(leakOf('Στις 21:00 — 120 BPM ♫ 🎧', 'Greek'), null);
});

test('an unknown language switches the guard off', () => {
  assert.equal(languageScripts('Klingon'), null);
  assert.equal(allowedScripts({ primary: 'Klingon', mix: [] }), null);
  assert.equal(leakOf('Qapla\' 驱动 σκοτεινό', 'Klingon'), null);
  // An unknown language in a mix switches it off as well.
  assert.equal(leakOf('Hello there 驱动 friends of the night', 'English', [], ['Klingon']), null);
});

test('a line written mostly in the foreign script is a language switch, not a stray word', () => {
  // A misdeclared language must not silence the DJ: such a line is left alone.
  assert.equal(leakOf('Καλησπέρα σας, συνεχίζουμε με μουσική.', 'English'), null);
  assert.ok(leakOf('Good evening everybody, here we go, 自身.', 'English'));
});

test('language entries are read by code, English name or native name', () => {
  assert.deepEqual(languageScripts('el'), ['Greek']);
  assert.deepEqual(languageScripts('Ελληνικά'), ['Greek']);
  assert.deepEqual(languageScripts('English (UK)'), ['Latin']);
  assert.deepEqual(languageScripts('en-GB'), ['Latin']);
  assert.deepEqual(languageScripts('Brazilian Portuguese'), ['Latin']);
  assert.deepEqual(languageScripts('ja_JP'), ['Han', 'Hiragana', 'Katakana']);
  assert.deepEqual(languageScripts('日本語'), ['Han', 'Hiragana', 'Katakana']);
  assert.deepEqual(languageScripts('zh-Hant'), ['Han', 'Bopomofo']);
  assert.deepEqual(languageScripts('ko'), ['Hangul', 'Han']);
  assert.deepEqual(languageScripts('Русский'), ['Cyrillic']);
  assert.deepEqual(languageScripts('ar'), ['Arabic']);
  assert.deepEqual(languageScripts('Hindi'), ['Devanagari']);
  // A multilingual speaker may write in every script of its mix.
  assert.equal(leakOf('Καλησπέρα, 次は静かな曲, απόψε.', 'Greek', [], ['Japanese']), null);
});

test('the verdict is the surface\'s: speech is retried once then dropped, a note loses only the stray runs', () => {
  const greek = lang('Greek');
  assert.deepEqual(scriptLeakVerdict('Καλό βράδυ σε όλους.', { ...greek, surface: 'speech', retry: true }), { action: 'keep' });
  assert.equal(scriptLeakVerdict('τηνAA自身 του ήχου απόψε', { ...greek, surface: 'speech', retry: true }).action, 'regenerate');
  assert.equal(scriptLeakVerdict('τηνAA自身 του ήχου απόψε', { ...greek, surface: 'speech' }).action, 'drop');
  const note = scriptLeakVerdict('124 BPM驱动βήμα, ζεστό και σταθερό για το βράδυ', { ...greek, surface: 'note' });
  assert.equal(note.action, 'strip');
  assert.equal(note.action === 'strip' && note.text, '124 BPM βήμα, ζεστό και σταθερό για το βράδυ');
  assert.equal(scriptLeakVerdict('Ζεστά电子τικά synths, ήρεμο κλείσιμο της βραδιάς', { ...greek, surface: 'note' }).action, 'strip');
  assert.equal(scriptLeakVerdict('ζεστά电子τικά', { ...greek, surface: 'note' }).action, 'plain', 'too little left to mean anything');
  assert.equal(scriptLeakVerdict('驱动 βήμα', { ...greek, surface: 'note' }).action, 'plain');
});

test('taking runs out tidies the spacing and never merges two words', () => {
  assert.equal(withoutLeakedRuns('124 BPM驱动βήμα', ['驱动']), '124 BPM βήμα');
  assert.equal(withoutLeakedRuns('ζεστό, но σκοτεινό.', ['но']), 'ζεστό, σκοτεινό.');
  assert.equal(withoutLeakedRuns("4A延续 1A's", ['延续']), "4A 1A's");
  assert.equal(withoutLeakedRuns('αργό 自身 .', ['自身']), 'αργό.');
});

// ── look-alikes, mixed words and leftover punctuation ───────────────────────

const greekOpts = { ...lang('Greek') };
const verdictText = (v: any) => ('text' in v ? v.text : null);

test('a look-alike run inside a word is folded into the word\'s script, not cut', () => {
  // Seen on air: a Cyrillic а and р opening a Greek word.
  const note = scriptLeakVerdict('Ζεστά арμονικά synths, ήρεμο κλείσιμο της βραδιάς', { ...greekOpts, surface: 'note' });
  assert.equal(note.action, 'fold');
  assert.equal(verdictText(note), 'Ζεστά αρμονικά synths, ήρεμο κλείσιμο της βραδιάς');
  assert.deepEqual((note as any).folds, [{ from: 'ар', to: 'αρ' }]);
  assert.equal(leakOf('Ζεστά арμονικά synths', 'Greek'), null, 'a fold is not a leak');
  // The target is the touching word's script: Latin next to Latin letters.
  const english = scriptLeakVerdict('Hellо and welcome back to the night shift.', { ...lang('English'), surface: 'speech', retry: true });
  assert.equal(english.action, 'fold', 'a spoken line is mended, not retried or dropped');
  assert.equal(verdictText(english), 'Hello and welcome back to the night shift.');
  // A combining mark between the word and the run is looked past.
  assert.equal(verdictText(scriptLeakVerdict('Hell\u0332о there, welcome back to the show.', { ...lang('English'), surface: 'speech' })), 'Hell\u0332o there, welcome back to the show.');
  // A rewritten line loses its fullwidth punctuation too.
  assert.equal(verdictText(scriptLeakVerdict('Ζεστά арμονικά，ήρεμα και αργά απόψε', { ...greekOpts, surface: 'note' })), 'Ζεστά αρμονικά, ήρεμα και αργά απόψε');
  // A fold and a strip in one note: the strip keeps the mended word.
  assert.equal(verdictText(scriptLeakVerdict('Ζεστά арμονικά synths 驱动 για το ήρεμο βράδυ', { ...greekOpts, surface: 'note' })), 'Ζεστά αρμονικά synths για το ήρεμο βράδυ');
  // Accents survive the fold, a precomposed letter included.
  assert.equal(verdictText(scriptLeakVerdict('A naїve little tune for the night.', { ...lang('English'), surface: 'speech' })), 'A naïve little tune for the night.');
  assert.equal(verdictText(scriptLeakVerdict('μια ωραία μελωδία απόψε, κάτι πιο αργо\u0301', { ...greekOpts, surface: 'speech' })), 'μια ωραία μελωδία απόψε, κάτι πιο αργό');
});

test('a real foreign word is still taken out, alone or glued to a word', () => {
  const alone = scriptLeakVerdict('ζεστό και держ αργό για το βράδυ απόψε', { ...greekOpts, surface: 'note' });
  assert.equal(alone.action, 'strip');
  assert.equal(verdictText(alone), 'ζεστό και αργό για το βράδυ απόψε');
  const glued = scriptLeakVerdict('ζεστόдерж αργό για το βράδυ απόψε', { ...greekOpts, surface: 'note' });
  assert.equal(glued.action, 'strip', 'д and ж have no Greek twin, so the run is a word');
  assert.equal(verdictText(glued), 'ζεστό αργό για το βράδυ απόψε');
  // A run of look-alikes standing alone is a word too.
  assert.equal(scriptLeakVerdict('Ωραίο κομμάτι, но σκοτεινό λίγο.', { ...greekOpts, surface: 'speech' }).action, 'drop');
  assert.equal(scriptLeakVerdict('Ωραίο κομμάτι, ор σκοτεινό λίγο.', { ...greekOpts, surface: 'speech' }).action, 'drop');
});

test('a Russian speaker\'s Cyrillic is never folded into Latin', () => {
  const text = 'Привет, это сор и рост, Hello.';
  assert.deepEqual(scriptLeakVerdict(text, { ...lang('Russian'), surface: 'speech' }), { action: 'keep' });
  // A Latin letter inside a Cyrillic word folds into Cyrillic, the word's script.
  const v = scriptLeakVerdict('Привет, это хорoшо.', { ...lang('Russian'), surface: 'speech' });
  assert.equal(verdictText(v), 'Привет, это хорошо.');
});

test('a name supplied with mixed scripts stays exactly as given', () => {
  const text = 'Ακούμε τους Pоp Сity απόψε, ζεστό και αργό.';
  assert.deepEqual(scriptLeakVerdict(text, { ...greekOpts, names: ['Pоp Сity'], surface: 'speech' }), { action: 'keep' });
  assert.deepEqual(scriptLeakVerdict('Ακούμε το Ζeta απόψε.', { ...greekOpts, names: ['Ζeta'], surface: 'speech' }), { action: 'keep' });
});

test('a word gluing the speaker\'s script to Latin is mended, or judged when it cannot be', () => {
  // (b) a space missing before a supplied name.
  const spaced = scriptLeakVerdict('Ακούμε τοsaved απόψε.', { ...greekOpts, names: ['Saved'], surface: 'speech', retry: true });
  assert.equal(spaced.action, 'fold');
  assert.equal(verdictText(spaced), 'Ακούμε το saved απόψε.');
  // (c) no twin and no name: a leak on speech, once retried then dropped ...
  for (const text of ['Ένα ταξίδι μεLANΧΟΛΙΑΣ απόψε.', 'Απαλά λullabies για το βράδυ.', 'Ακούμε τοsaved απόψε.']) {
    const word = text.split(' ').find((w) => /\p{Script=Latin}/u.test(w) && /\p{Script=Greek}/u.test(w))!.replace(/\.$/, '');
    const retry = scriptLeakVerdict(text, { ...greekOpts, surface: 'speech', retry: true });
    assert.equal(retry.action, 'regenerate', text);
    assert.deepEqual((retry as any).leak.runs, [word], text);
    assert.equal(scriptLeakVerdict(text, { ...greekOpts, surface: 'speech' }).action, 'drop', text);
    // ... and left as written in a note, where cutting it would halve a word.
    assert.deepEqual(scriptLeakVerdict(`${text} Ζεστό και αργό.`, { ...greekOpts, surface: 'note' }), { action: 'keep' }, text);
  }
  // (a) every minority letter has a twin: folded into the majority's script.
  assert.equal(verdictText(scriptLeakVerdict('Ακούμε το Hellο απόψε.', { ...greekOpts, surface: 'speech' })), 'Ακούμε το Hello απόψε.');
  assert.equal(verdictText(scriptLeakVerdict('Ένα πολύ καλo κομμάτι.', { ...greekOpts, surface: 'speech' })), 'Ένα πολύ καλο κομμάτι.');
  assert.equal(verdictText(scriptLeakVerdict('Ένα πολύ καλó κομμάτι.', { ...greekOpts, surface: 'speech' })), 'Ένα πολύ καλό κομμάτι.');
  // An even split has no minority to fold.
  assert.equal(scriptLeakVerdict('Ακούμε το ραAB απόψε.', { ...greekOpts, surface: 'speech' }).action, 'drop');
  // Two of the speaker's own non-Latin scripts in one word are not this rule's.
  assert.deepEqual(scriptLeakVerdict('Ζεστά арμονικά synths', { ...lang('Greek', ['Russian']), surface: 'speech' }), { action: 'keep' });
  // A Latin-only speaker and an unspaced script are never judged this way.
  assert.deepEqual(scriptLeakVerdict('東京Tower 很好，BPM很稳。', { ...lang('Chinese'), surface: 'speech' }), { action: 'keep' });
  assert.deepEqual(scriptLeakVerdict('Moby, Kruder & Dorfmeister, 124 BPM in 8A.', { ...lang('English'), surface: 'speech' }), { action: 'keep' });
});

test('punctuation a stripped run leaves behind is made ASCII, unless the speaker writes it', () => {
  // Seen on air: a note left with fullwidth commas once its Han words were out.
  const note = scriptLeakVerdict('125bpm/8A 124bpm/10B，驱动driving night instrumental，unaired-ish fresh，新鲜.', { ...greekOpts, surface: 'note' });
  assert.equal(note.action, 'strip');
  assert.equal(verdictText(note), '125bpm/8A 124bpm/10B, driving night instrumental, unaired-ish fresh.');
  assert.equal(withAsciiPunctuation('ζεστό（αργό）：καλό。τέλος！', lang('Greek').languages), 'ζεστό (αργό): καλό. τέλος!');
  assert.equal(withAsciiPunctuation('ένα，，δύο ， .', lang('Greek').languages), 'ένα, δύο.');
  assert.equal(withAsciiPunctuation('，ένα、δύο', lang('Greek').languages), 'ένα, δύο');
  assert.equal(withAsciiPunctuation('ζεστό（ αργό ）και「ήρεμο」，', lang('Greek').languages), 'ζεστό (αργό) και “ήρεμο”');
  assert.equal(withAsciiPunctuation('ＢＰＭ，ζεστό　αργό～', lang('Greek').languages), 'ＢＰＭ, ζεστό αργό~', 'letters are never touched');
  // A Chinese speaker keeps its own punctuation.
  const zh = scriptLeakVerdict('节奏很稳，держ 适合夜晚，温暖的合成器。', { ...lang('Chinese'), surface: 'note' });
  assert.equal(zh.action, 'strip');
  assert.ok(!/д/.test(verdictText(zh)!));
  assert.match(verdictText(zh)!, /，.*，.*。$/);
  // A line the guard keeps is never touched, fullwidth marks and all.
  assert.deepEqual(scriptLeakVerdict('ζεστό，αργό και ήρεμο απόψε', { ...greekOpts, surface: 'note' }), { action: 'keep' });
});

// ── the speech gate ──────────────────────────────────────────────────────────

const template = settings.get().personas[0];
const GREEK = { ...template, id: 'p_greek', name: 'Ilios', language: 'Greek' };
const ENGLISH = { ...template, id: 'p_english', name: 'Nova', language: 'English' };
const SHOW = 's_leak';

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<boolean> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
let spoken: string[] = [];
const wav = join(root, 'leak.wav');
await writeSilentWav(wav, 100);
const leakLogged = () => queue.djLog.filter((e: any) => /another writing system/.test(e.message));

await settings.update({
  personas: [GREEK, ENGLISH], activePersonaId: GREEK.id,
  shows: [{ id: SHOW, name: 'Night Shift', topic: 'tests', personaId: GREEK.id, energies: ['medium'] }],
  schedule: weekFor(SHOW), scheduleOverride: null,
  tts: { enabled: true },
  llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', pickerAgent: false, fallback: { enabled: false } },
} as never);

beforeEach(() => {
  spoken = [];
  queue.djLog = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => true;
});

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('announce drops a leaking line before TTS, reports it as a stand-in drop, and logs the letters once', async () => {
  const out = await queue.announce('Συνεχίζουμε απόψε με τηνAA自身 του ένταση.', 'programme-feature', { persona: GREEK as never });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'stand-in', 'callers stand down exactly as for a stand-in');
  assert.deepEqual(spoken, []);
  assert.equal(leakLogged().length, 1);
  assert.match(leakLogged()[0].message, /"自身"/);
});

test('the deferred path and an exchange drop a leaking line too', async () => {
  await queue.announceAtNextTrack('Και τώρα, κάτι ζεστά电子τικά για το βράδυ.', 'station-id', { persona: GREEK as never });
  assert.deepEqual(spoken, []);
  await queue.announceExchange([
    { persona: GREEK as never, text: 'Ωραίο κομμάτι, но σκοτεινό λίγο.' },
    { persona: ENGLISH as never, text: 'Lovely and slow, that one.' },
  ], 'banter', { castNames: [GREEK.name, ENGLISH.name] });
  assert.deepEqual(spoken, ['Lovely and slow, that one.']);
  assert.equal(leakLogged().length, 2, 'each drop is the leak gate\'s, logged once');
});

test('a clean line airs byte-identical, and a name on air in another script airs with it', async () => {
  const english = 'That was Porcelain by Moby, and here comes the night.';
  assert.equal((await queue.announce(english, 'station-id', { persona: ENGLISH as never })).accepted, true);
  queue.current = { track: { id: 'jp', title: '稲妻', artist: 'ウルフルズ' } } as never;
  const greek = 'Ακούσαμε τους ウルフルズ, και συνεχίζουμε απόψε.';
  assert.equal((await queue.announce(greek, 'station-id', { persona: GREEK as never })).accepted, true);
  assert.deepEqual(spoken, [english, greek]);
  assert.equal(leakLogged().length, 0);
});

test('a spoken line with only look-alike letters airs mended, logged once', async () => {
  const out = await queue.announce('Hellо and welcome back to the night shift.', 'station-id', { persona: ENGLISH as never });
  assert.equal(out.accepted, true);
  assert.deepEqual(spoken, ['Hello and welcome back to the night shift.']);
  assert.equal(leakLogged().length, 0);
  assert.equal(queue.djLog.filter((e: any) => /look-alike/.test(e.message)).length, 1);
  const song = { id: 'l', title: 'Porcelain', artist: 'Moby' };
  assert.equal(trimLinkToIntro('Το Porcelain του Moby, ζεστές арμονίες.', song, GREEK as never, queue as never), 'Το Porcelain του Moby, ζεστές αρμονίες.');
});

test('operator text is never judged', async () => {
  const raw = 'Καλησπέρα 自身 από το studio.';
  const out = await queue.announce(raw, 'dj-say', { persona: GREEK as never, meta: { verbatim: true } as never });
  assert.equal(out.accepted, true);
  assert.equal(leakLogged().length, 0);
});

test('push() queues the track without a leaking intro and says so, so no caller records it as said', async () => {
  let dropped = 0;
  await queue.push({
    track: { id: 'pushed', title: 'Θάλασσα', artist: 'Some Band' } as never,
    introScript: 'Το Θάλασσα από τους Some Band, 124 BPM驱动 ρυθμός.',
    introPersona: GREEK as never,
    onStandInDropped: () => { dropped++; },
  });
  const item = queue.upcoming.find(i => i.track.id === 'pushed')!;
  assert.ok(item, 'the track is still queued: music never stops for this');
  assert.equal(item.introScript, null);
  assert.equal(dropped, 1);
  // A Japanese title supplied with the pushed track is its name, and stays.
  await queue.push({
    track: { id: 'named', title: '東京', artist: 'Some Band' } as never,
    introScript: 'Το 東京 από τους Some Band, απόψε.',
    introPersona: GREEK as never,
  });
  assert.equal(queue.upcoming.find(i => i.track.id === 'named')!.introScript, 'Το 東京 από τους Some Band, απόψε.');
});

test('a pick link that leaks is dropped before the agent records it as the pick\'s say', () => {
  const song = { id: 'l', title: 'Porcelain', artist: 'Moby' };
  assert.equal(trimLinkToIntro('Το Porcelain του Moby, ζεστά电子τικά.', song, GREEK as never, queue as never), null);
  assert.equal(trimLinkToIntro('Το Porcelain του Moby, ζεστό και αργό.', song, GREEK as never, queue as never), 'Το Porcelain του Moby, ζεστό και αργό.');
});

// ── the writer's one retry ───────────────────────────────────────────────────

let replies: string[] = [];
let requests = 0;
globalThis.fetch = (async () => {
  requests++;
  const content = replies.shift() ?? 'Καλησπέρα.';
  return chatCompletionResponse({ id: 'fixture', message: { role: 'assistant', content } });
}) as typeof fetch;

test('a free-text line that leaks is regenerated once, and the clean retry is what comes back', async () => {
  replies = ['Καλησπέρα, είμαστε 自身 στο σταθμό.', 'Καλησπέρα, είμαστε εδώ στο σταθμό.'];
  requests = 0;
  const line = await generateStationId({ persona: GREEK, context: {} });
  assert.equal(line, 'Καλησπέρα, είμαστε εδώ στο σταθμό.');
  assert.equal(requests, 2);
});

test('a retry that leaks again is not retried a second time, and the gate drops it unrecorded', async () => {
  replies = ['Καλησπέρα 自身 σταθμός μας απόψε.', 'Καλησπέρα 驱动 σταθμός μας απόψε.'];
  requests = 0;
  const line = await generateStationId({ persona: GREEK, context: {} });
  assert.equal(requests, 2, 'at most one retry: the default model is a slow homelab server');
  const out = await queue.announce(line, 'station-id', { persona: GREEK as never });
  assert.equal(out.accepted, false);
  assert.deepEqual(spoken, []);
  assert.ok(!queue.djLog.some((e: any) => e.kind === 'dj' && /σταθμός/.test(e.message)), 'never recorded as said');
});

test('a line with only look-alike letters comes back mended, with no retry', async () => {
  replies = ['Καλησπέρα, είμαστε εδώ με αрμονίες απόψε.'];
  requests = 0;
  assert.equal(await generateStationId({ persona: GREEK, context: {} }), 'Καλησπέρα, είμαστε εδώ με αρμονίες απόψε.');
  assert.equal(requests, 1);
});

test('a clean English line costs one call and comes back unchanged', async () => {
  replies = ['This is the night shift, stay with us.'];
  requests = 0;
  assert.equal(await generateStationId({ persona: ENGLISH, context: {} }), 'This is the night shift, stay with us.');
  assert.equal(requests, 1);
});

// ── pick notes ───────────────────────────────────────────────────────────────

test('a pick note keeps its words when a stray run is taken out of it', () => {
  const track = { id: 't1', title: 'Porcelain', artist: 'Moby' };
  const note = groundPickNote(queue, 'Το Porcelain του Moby, 124 BPM驱动βήμα, ζεστό και αργό για το βράδυ', { track, candidates: [track], route: 'pick' });
  assert.equal(note, 'Το Porcelain του Moby, 124 BPM βήμα, ζεστό και αργό για το βράδυ');
  assert.ok(queue.djLog.some((e: any) => /another writing system \("驱动"\).*kept the rest/.test(e.message)), 'logged once, with the letters');
  assert.equal(queue.djLog.filter((e: any) => /another writing system/.test(e.message)).length, 1);
});

test('a pick note with too little left falls back to the plain credit, Title — Artist', () => {
  const track = { id: 't1', title: 'Porcelain', artist: 'Moby' };
  const note = groundPickNote(queue, '驱动电子 βήμα', { track, candidates: [track], route: 'pick' });
  assert.equal(note, '');
  assert.equal(agenticDiscoverySelectionReason(track, note, [], 'Greek'), '“Porcelain” — Moby');
  assert.equal(shortlistClauseSelectionReason(track, note, 'Greek'), '“Porcelain” — Moby');
  assert.ok(queue.djLog.some((e: any) => /another writing system .*plain copy/.test(e.message)));
});

test('a pick note naming a supplied track in another script keeps its words', () => {
  const track = { id: 't2', title: '稲妻', artist: 'ウルフルズ' };
  const text = 'Οι ウルフルズ με το 稲妻, ζεστό και γρήγορο για το βράδυ';
  assert.equal(groundPickNote(queue, text, { track, candidates: [track], route: 'shortlist' }), text);
});

test('a pick note with a look-alike run keeps the whole word', () => {
  const track = { id: 't3', title: 'Porcelain', artist: 'Moby' };
  const note = groundPickNote(queue, 'Το Porcelain του Moby, арμονικά και ζεστά για το βράδυ', { track, candidates: [track], route: 'pick' });
  assert.equal(note, 'Το Porcelain του Moby, αρμονικά και ζεστά για το βράδυ');
  assert.equal(queue.djLog.filter((e: any) => /look-alike/.test(e.message)).length, 1);
});
