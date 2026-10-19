// M1 wiring: a stated clock copied from the DJ's earlier speech never reaches
// a prompt again, and a wrong one never reaches air.
//
// clock-phrases.test.ts pins the matcher; this pins the CALLERS, which is
// where the bug actually lived: the recap, the opener list and the agent's
// chat window each handed the model its own stale "just after ten", and
// nothing checked the time a finished line stated. Asserts on what reaches
// the prompt builders and _speak, not on the helper.
//
// Run: npm test -- clock-phrases-wiring

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-clock-wiring-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { promptRecapEntries } = await import('../src/broadcast/prompt-memory.js');
const { getClockContext } = await import('../src/context.js');
const { fuzzyAirTime } = await import('../src/llm/internal/prompts/scripts.js');
const { speakClockAllowed } = await import('../src/broadcast/clock-policy.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

// The two private seams every speech-boundary test replaces: TTS and air.
type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<boolean> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const GREEK = { ...template, id: 'p_el', name: 'Niki', language: 'Greek' };
const SHOW = 's_clock';

const WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
// An hour at least three away from now, so the phrase can never be in tolerance.
// Station-zone hour, the clock the queue judges against (not the test host's).
const wrongHour = () => WORDS[(Number(getClockContext(new Date()).hhmm.slice(0, 2)) + 4) % 12];

function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'The Free Electron', topic: 'tests' },
  } as unknown as Parameters<typeof session.start>[0];
}

let spoken: string[] = [];
const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

beforeEach(async () => {
  spoken = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue._pendingVoice = null;
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => true;
  await settings.update({
    personas: [HOST, GREEK], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'The Free Electron', topic: 'tests', personaId: HOST.id, energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
  } as never);
  session.start(ctx());
});

after(async () => {
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

// The air-time correction the queue will apply right now.
function expectedFix(): string | null {
  return speakClockAllowed() ? fuzzyAirTime(getClockContext(new Date())) : null;
}

// ── prompt memory ────────────────────────────────────────────────────────────

test('the recap drops the sentence that states a clock, and keeps the rest', () => {
  const t = new Date(Date.now() - 12 * 60_000).toISOString();
  const [entry] = promptRecapEntries(
    [{ t, kind: 'link', message: 'The Free Electron rolls through Plakias just after ten on a Monday. Here is Len Faki.' }],
    { limit: 10, withinMinutes: 120, maxChars: 140 },
  );
  assert.equal(entry.message, 'Here is Len Faki.');
});

// The fragment the old phrase-level strip left ("in the afternoon on The Free
// Electron.") is what qwythos re-aired on 18 Oct; no fragment may reach the
// recap at all.
test('a recap line whose only sentence states the clock is dropped, never left as a fragment', () => {
  const t = new Date(Date.now() - 5 * 60_000).toISOString();
  const picked = promptRecapEntries(
    [
      { t, kind: 'hourly-check', message: 'One down for our afternoon on The Free Electron and just gone four.' },
      { t, kind: 'station-id', message: 'Southern Star.' },
    ],
    { limit: 10, withinMinutes: 120, maxChars: 140 },
  );
  assert.deepEqual(picked.map(e => e.message), ['Southern Star.']);
});

test('a recap line that was only a clock is dropped, not kept empty', () => {
  const t = new Date(Date.now() - 5 * 60_000).toISOString();
  const picked = promptRecapEntries(
    [{ t, kind: 'link', message: 'Half past ten.' }, { t, kind: 'station-id', message: 'Southern Star.' }],
    { limit: 10, withinMinutes: 120, maxChars: 140 },
  );
  assert.ok(picked.every(e => e.message && !/half past/i.test(e.message)));
});

test('the opener list never names the old time', () => {
  session.appendTurn({ role: 'segment', kind: 'link', text: 'Just after ten on a proper Monday. Here is Steve Miller.', meta: { personaId: HOST.id } });
  const openers = queue.getRecentOpeners();
  assert.ok(openers.length >= 1);
  assert.ok(openers.every(o => !/after ten/i.test(o)), openers.join(' | '));
});

test('the agent chat window replays aired lines without their clock', () => {
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Pick the track to play next.' });
  session.appendTurn({ role: 'segment', kind: 'station-id', text: 'Southern Star Plakias Radio. It is just after two on a proper Monday.', meta: { personaId: HOST.id } });
  const aired = session.windowMessages().filter(m => m.role === 'assistant').map(m => m.content).join('\n');
  assert.match(aired, /Southern Star Plakias Radio/);
  assert.doesNotMatch(aired, /after two|on a proper Monday/);
});

test('an aired line that was only a clock adds no empty turn to the chat window', () => {
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Pick the track to play next.' });
  session.appendTurn({ role: 'segment', kind: 'hourly-check', text: 'Just gone four in the afternoon.', meta: { personaId: HOST.id } });
  const msgs = session.windowMessages();
  assert.ok(msgs.every(m => m.content.trim().length > 0), JSON.stringify(msgs));
  assert.ok(msgs.every(m => !/in the afternoon/.test(m.content)), JSON.stringify(msgs));
});

test('the session file keeps the words that aired, clock included', () => {
  session.appendTurn({ role: 'segment', kind: 'link', text: 'It is just past four on a Monday.', meta: { personaId: HOST.id } });
  const turns = session.promptMemory();
  assert.ok(turns.some(t => /just past four/.test(t.message)), 'only the PROMPT copy is stripped');
});

// ── what reaches air ─────────────────────────────────────────────────────────

test('a scheduled line stating a wrong time airs with the air time instead', async () => {
  const wrong = `just after ${wrongHour()}`;
  await queue.announce(`Southern Star Plakias Radio, ${wrong} on a proper Monday.`, 'station-id', { persona: HOST as never });
  assert.equal(spoken.length, 1);
  assert.doesNotMatch(spoken[0], new RegExp(wrong));
  const fix = expectedFix();
  if (fix) assert.ok(spoken[0].includes(fix), spoken[0]);
});

test('the deferred path is checked too', async () => {
  const wrong = `half past ${wrongHour()}`;
  await queue.announceAtNextTrack(`Southern Star. It is ${wrong} and the coast is quiet.`, 'station-id', { persona: HOST as never });
  assert.equal(spoken.length, 1);
  assert.doesNotMatch(spoken[0], new RegExp(wrong));
});

test('a line stating the right time airs untouched', async () => {
  const fix = expectedFix();
  if (!fix) return; // a station with the spoken clock off has no "right time" to keep
  const line = `Southern Star, ${fix} on a proper Monday.`;
  await queue.announce(line, 'station-id', { persona: HOST as never });
  assert.equal(spoken[0], line);
});

test('the hourly check is the clock: exempt', async () => {
  const line = `It's ${wrongHour()} o'clock, here are the headlines.`;
  await queue.announce(line, 'hourly-check', { persona: HOST as never });
  assert.equal(spoken[0], line);
});

test('operator text airs as typed (POST /dj/say passes verbatim)', async () => {
  const line = `Meet us at the bar just after ${wrongHour()} tonight.`;
  await queue.announce(line, 'dj-speak', { verbatim: true });
  assert.equal(spoken[0], line);
});

test('a non-English persona passes unchanged (fail open)', async () => {
  const line = `Kalispera, just after ${wrongHour()} on Plakias radio.`;
  await queue.announce(line, 'station-id', { persona: GREEK as never });
  assert.equal(spoken[0], line);
});
