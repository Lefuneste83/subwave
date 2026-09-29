// A boundary handoff that airs AFTER the session has rolled must not keep
// handoffInProgress() true for the whole incoming show
// (session.retireAiredBoundaryHandoff).
//
// THE DEFECT THIS GUARDS. maybeRoll carries a still-armed/queued record onto
// the incoming session; markHandoffAired then flipped it to aired there and
// nothing ever cleared it. handoffInProgress() stayed true, so every scheduled
// link / station id / banter was dropped ("the show handoff has already
// claimed this boundary"). Seen live: 23:00 Tom Avro → The Dead Professor
// (The Minoan Cave), the pair aired late, /debug showed
// boundaryHandoff.state "aired" an hour later and the DJ never spoke again.
//
// Run: npm test -- handoff-aired-after-roll

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-aired-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');

after(() => rmSync(root, { recursive: true, force: true }));

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom Avro' };
const PROF = { ...template, id: 'p_prof', name: 'The Dead Professor' };
const RUTTI = { id: 'rutti', title: 'Rutti', artist: 'Slowdive' };
const CAVE = { id: 's_cave', name: 'The Minoan Cave' };

function blankSchedule() {
  const week: Record<number, null[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(null);
  return week;
}

function context(show: { id: string; name: string }, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'night', vibe: 'night', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    date: {}, clock: {}, listeners: 1,
    activeShow: { ...show, topic: '', moods: ['calm'] },
  } as SessionContext;
}

// Outgoing show on air, incoming show armed on its final track.
async function armed(): Promise<number> {
  await settings.update({
    personas: [TOM, PROF], activePersonaId: TOM.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_shadowplay', name: 'Shadowplay' }, now));
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(CAVE.id);
  await settings.update({
    activePersonaId: PROF.id,
    shows: [{ ...CAVE, topic: 'caves', personaId: PROF.id }],
    schedule: week,
  } as never);
  assert.equal(session.armBoundaryHandoff(context(CAVE, now + 5 * 60_000), RUTTI), true);
  return now;
}

test('aired BEFORE the roll → still guards the outgoing show', async () => {
  await armed();
  session.markHandoffQueued();
  session.markHandoffAired();
  assert.equal(session.handoffInProgress(), true);
  assert.equal(session.boundaryHandoffStatus()?.state, 'aired');
});

test('carried across the roll, aired after it → released for the incoming show', async () => {
  const now = await armed();
  const next = await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  assert.equal(next.show?.id, CAVE.id);
  assert.ok(next.boundaryHandoff, 'the un-aired record rides onto the incoming session');
  session.markHandoffQueued();
  assert.equal(session.handoffInProgress(), true, 'queued still holds the air');
  session.markHandoffAired();
  assert.equal(session.handoffInProgress(), false, 'scheduled speech is allowed again');
  assert.equal(session.boundaryHandoffStatus(), null);
  assert.equal(session.pendingHandoff(), null, 'no second mic-pass');
  assert.equal(session.getSession()?.handoffAired, true);
});

test('a session already stuck with an aired record self-heals on read', async () => {
  const now = await armed();
  await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  // Simulate the persisted state from before the fix.
  const s = session.getSession()!;
  s.boundaryHandoff!.aired = true;
  s.boundaryHandoff!.queued = false;
  assert.equal(session.handoffInProgress(), false);
  assert.equal(session.getSession()?.boundaryHandoff, null);
});

test('retiring keeps a programme attached only to the record', async () => {
  const now = await armed();
  await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  const s = session.getSession()!;
  s.programme = null;
  const programme = { showId: CAVE.id, episode: 'e1' } as never;
  s.boundaryHandoff!.programme = programme;
  session.markHandoffAired();
  assert.equal(session.getProgramme(), programme);
});
