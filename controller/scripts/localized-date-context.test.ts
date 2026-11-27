// The date in the speaker's own language, the coarse daypart for a prompt that
// carries neither the clock nor the period, and the next-presenter rule on
// links. A Greek host handed only "Thursday, 26 November" aired a Thursday as
// Tuesday and November as February; a link with no daypart had the sun setting
// at 20:31; a link with no following show named the wrong next presenter.
// Run: npm test -- localized-date-context

import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-localized-date-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');
const { getFullContext } = await import('../src/context.js');
const { languageLocale, localizedDayLabel } = await import('../src/util/language-locale.js');

mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
  current: { temperature_2m: 12, weather_code: 0, is_day: 0 },
})));
after(async () => {
  mock.restoreAll();
  await removeTempDir(root);
});

await settings.load();

// Thursday 26 November, 20:31, after dark: a fixed moment, no clock involved.
const moment = () => ({
  at: '2026-11-26T19:31:00.000Z',
  date: { iso: '2026-11-26', dayOfWeek: 4, dayLabel: 'Thursday', dayOfMonth: 26, monthLabel: 'November', season: 'autumn' },
  clock: { hhmm: '20:31', display: '20:31', isDark: true, isWeekend: false, isLateNight: false, isCommute: false },
  time: { period: 'evening', vibe: 'wind down' },
});
const DATE_FIELDS = ['date', 'clock', 'time'];
const ENGLISH_DAY = 'Day: Thursday, 26 November (autumn)';
const persona = (language: string) => ({ id: 'p_t', name: 'Host', language });

test('a Greek or French speaker gets the day and month in their own words beside the unchanged English line', () => {
  const greek = buildContextLines(moment(), { contextFields: DATE_FIELDS, speaker: persona('Greek') });
  assert.equal(greek[0], ENGLISH_DAY);
  assert.equal(greek[1], 'Day in Greek: Πέμπτη 26 Νοεμβρίου (when you name the day or the month, use exactly these words)');
  const native = buildContextLines(moment(), { contextFields: DATE_FIELDS, speaker: persona('Ελληνικά') });
  assert.match(native[1], /^Day in Ελληνικά: Πέμπτη 26 Νοεμβρίου /);
  const french = buildContextLines(moment(), { contextFields: DATE_FIELDS, speaker: persona('French') });
  assert.equal(french[0], ENGLISH_DAY);
  assert.match(french[1], /^Day in French: jeudi 26 novembre /);
});

test('an English, unset or unknown language keeps the context lines byte-identical', () => {
  const expected = [ENGLISH_DAY, 'Local time: 20:31 · after dark', 'Period: evening (wind down)'];
  for (const language of ['English', 'en-GB', '', 'Klingon']) {
    assert.deepEqual(buildContextLines(moment(), { contextFields: DATE_FIELDS, speaker: persona(language) }), expected, language);
  }
  assert.deepEqual(buildContextLines(moment(), { contextFields: DATE_FIELDS, speaker: null }), expected);
});

test('without a speaker the persona on air at the context moment decides the language', async () => {
  const template = settings.get().personas[0];
  await settings.update({ personas: [{ ...template, language: 'Greek' }] });
  try {
    const lines = buildContextLines(moment(), { contextFields: DATE_FIELDS });
    assert.ok(lines.some((l: string) => l.startsWith('Day in Greek: Πέμπτη 26 Νοεμβρίου')), lines.join('\n'));
  } finally {
    await settings.update({ personas: [template] });
  }
});

test('the clock switch withholds the time but neither the localized date nor the daypart', async () => {
  await settings.update({ djSpeakClock: false });
  try {
    const lines = buildContextLines(moment(), { contextFields: ['date', 'clock'], speaker: persona('Greek') });
    assert.deepEqual(lines, [
      ENGLISH_DAY,
      'Day in Greek: Πέμπτη 26 Νοεμβρίου (when you name the day or the month, use exactly these words)',
      'Vibe: after dark',
      'Part of day: evening',
    ]);
    assert.ok(!lines.some((l: string) => /20:31|Local time/.test(l)));
  } finally {
    await settings.update({ djSpeakClock: true });
  }
});

test('a skill whose context lacks the clock and the period still gets a coarse daypart', () => {
  assert.deepEqual(buildContextLines(moment(), { contextFields: ['show'], speaker: null }), ['Part of day: evening · after dark']);
  const noon = { ...moment(), clock: { ...moment().clock, hhmm: '11:35', display: '11:35', isDark: false } };
  assert.deepEqual(buildContextLines(noon, { contextFields: ['date'], speaker: null }), [ENGLISH_DAY, 'Part of day: morning · daylight']);
  const small = { ...moment(), clock: { ...moment().clock, hhmm: '02:10', isLateNight: true } };
  assert.deepEqual(buildContextLines(small, { contextFields: ['show'], speaker: null }), ['Part of day: night · after dark']);
  // The time or the period already says it: nothing added.
  assert.deepEqual(buildContextLines(moment(), { contextFields: ['clock'], speaker: null }), ['Local time: 20:31 · after dark']);
  assert.deepEqual(buildContextLines(moment(), { contextFields: ['time'], speaker: null }), ['Period: evening (wind down)']);
});

test('a link carries the localized date and the daypart as facts, English links only the daypart', () => {
  const greek = linkPrompt({ context: moment(), persona: persona('Greek') });
  assert.match(greek, /^- Day: Thursday\.$/m);
  assert.match(greek, /^- Day in Greek: Πέμπτη 26 Νοεμβρίου \(when you name the day or the month, use exactly these words\)\.$/m);
  assert.match(greek, /^- Part of day: evening, after dark\.$/m);
  const english = linkPrompt({ context: moment(), persona: persona('English') });
  assert.doesNotMatch(english, /Day in /);
  assert.match(english, /^- Part of day: evening, after dark\.$/m);
});

test('a link names the next presenter only from the schedule, and is told not to guess otherwise', async () => {
  const template = settings.get().personas[0];
  const outgoing = { ...template, id: 'p_out', name: 'Outgoing', language: 'Greek' };
  const incoming = { ...template, id: 'p_in', name: 'Incoming', language: 'Greek' };
  const schedule: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) schedule[day] = Array(24).fill('s_out');
  schedule[4][14] = 's_in';
  await settings.update({
    timezone: 'UTC', personas: [outgoing, incoming], schedule,
    shows: [
      { id: 's_out', name: 'Outgoing show', personaId: outgoing.id },
      { id: 's_in', name: 'Incoming show', personaId: incoming.id },
    ],
    djBehaviour: { previewNextShow: true },
  });
  const NO_GUESS = /do not name, announce or guess who or what comes on air after this show/;
  const early = await getFullContext(new Date('2026-11-26T13:30:00Z'));
  assert.equal(early.showHandover, null);
  const earlyPrompt = linkPrompt({ context: early, persona: outgoing });
  assert.match(earlyPrompt, NO_GUESS);
  assert.doesNotMatch(earlyPrompt, /Following show|Incoming/);

  const late = await getFullContext(new Date('2026-11-26T13:50:00Z'));
  const latePrompt = linkPrompt({ context: late, persona: outgoing });
  assert.match(latePrompt, /Following show: Incoming presents "Incoming show"/);
  assert.doesNotMatch(latePrompt, NO_GUESS);
  // Only the name: a persona's soul never reaches another persona's prompt.
  if (incoming.soul) assert.ok(!latePrompt.includes(String(incoming.soul)));

  await settings.update({ djBehaviour: { previewNextShow: false } });
  const off = await getFullContext(new Date('2026-11-26T13:50:00Z'));
  const offPrompt = linkPrompt({ context: off, persona: outgoing });
  assert.match(offPrompt, NO_GUESS);
  assert.doesNotMatch(offPrompt, /Following show/);
});

test('one mapping from a free-text language to a locale ICU formats', () => {
  for (const [language, locale] of [
    ['Greek', 'el'], ['Ελληνικά', 'el'], ['ελληνικα', 'el'], ['el', 'el'], ['el_GR', 'el-GR'], ['gre', 'el'],
    ['French', 'fr'], ['français', 'fr'], ['Brazilian Portuguese', 'pt'], ['Castellano', 'es'], ['日本語', 'ja'],
    ['English (UK)', 'en'],
  ] as const) assert.equal(languageLocale(language), locale, language);
  for (const unknown of ['Klingon', 'xx', '', null, undefined]) assert.equal(languageLocale(unknown), null, String(unknown));
  assert.equal(localizedDayLabel('2026-11-26', 'English'), null);
  assert.equal(localizedDayLabel('not a date', 'Greek'), null);
  // Gregorian whatever the locale's default calendar, so it names the English line's day.
  assert.match(localizedDayLabel('2026-11-26', 'Farsi') ?? '', /۲۶/);
});
