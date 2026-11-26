// Library → Transitions (music/transition-readiness-policy.ts and
// music/transition-readiness.ts): which Hot Mix transition each track can take
// at best, counted with the seam planner's and the picker's own rules.
//
// Pinned here:
//   - each tier boundary: no Hot Mix tempo (no grid, held, reverted,
//     unmeasurable, failed, an applied grid with no tempo) is `out`; a tempo
//     without a segment the seam trusts (no downbeat, under 8 beats, a period
//     off the tempo) is `safe`; trusted bars without a usable structure are
//     `beat`, with why (bars held by the grid policy, the half-bar case, not
//     measured, an older grid, unmeasurable by reason, failed, no full
//     section); a structure on the current grid with a full section is
//     `phrase`, split by whether its intro holds a phrase;
//   - the structure's bars are parsed only for a track that reaches the
//     phrase check;
//   - canEnterOnPhrase says what planPhraseWindow says about an incoming intro
//     at the longest phrase, its depth and a groove before the entry included;
//   - a show's reach is the show editor's (withinCurveReach), octave-safe, and
//     a show without a curve reaches every known tempo;
//   - the pass lands its counts in the snapshot; the read never counts (the
//     first read answers null and the pass runs after it); a recount runs only
//     when an input moved.
// Run: npm test -- transition-readiness

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-transition-readiness-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'pw';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const settings = await import('../src/settings.js');
await settings.load();
const policy = await import('../src/music/transition-readiness-policy.js');
const pass = await import('../src/music/transition-readiness.js');
const { planPhraseWindow, canEnterOnPhrase } = await import('../src/music/phrase-mix-policy.js');
const { structurePoints } = await import('../src/music/structure-policy.js');
const { hotMixOf } = await import('../src/music/hot-mix-policy.js');
const { transitionReadinessResponseSchema } = await import('../src/schemas/transition-readiness.js');
const maintenance = (await import('../src/routes/library/maintenance.js')).router;

after(async () => { db.close(); await removeTempDir(dir); });

type Facts = Parameters<typeof policy.readinessOf>[0];
type Grid = NonNullable<Facts['grid']>;

const AT = '2026-11-01T00:00:00.000Z';
// 124 BPM, one long segment with a settled downbeat.
const SEG = { anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 };
function grid(o: Partial<Grid> = {}): Grid {
  return {
    status: 'ok', applied: 1, bpm: 124, beatsPerBar: 4, segments: [SEG], coverage: 0.98,
    downbeatAgreement: 0.9, downbeatHalfbar: null, downbeatDropDb: null, downbeatPhase: null,
    decodedMs: 340_000, measuredAt: AT, ...o,
  };
}
// `intro` soft bars, then `full` full-section bars.
function bars(intro: number, full = 32) {
  const n = intro + full;
  return {
    runs: [[480, 1_935_484, n]] as Array<[number, number, number]>,
    kick: [...Array(intro).fill(-10), ...Array(full).fill(0)],
    kicks: Array(n).fill(4),
    bass: [...Array(intro).fill(-20), ...Array(full).fill(-2)],
    mid: [...Array(intro).fill(-8), ...Array(full).fill(-1)],
    high: Array(n).fill(-3),
    level: Array(n).fill(-1),
    melody: Array(n).fill(6),
  };
}
const NO_FULL = { ...bars(0, 40), kick: Array(40).fill(-10) };
function structure(o: Partial<NonNullable<Facts['structure']>> = {}): NonNullable<Facts['structure']> {
  return { status: 'ok', reason: null, gridAt: AT, bars: bars(16), ...o };
}
const facts = (o: Partial<Facts> = {}): Facts => ({ bpm: 124, grid: grid(), structure: structure(), ...o });
const tierOf = (f: Facts) => {
  const r = policy.readinessOf(f);
  return r.reason ? `${r.tier}/${r.part}/${r.reason}` : `${r.tier}/${r.part}`;
};

test('out: no Hot Mix tempo, by why', () => {
  assert.equal(tierOf(facts({ grid: null, structure: null })), 'out/no-grid');
  assert.equal(tierOf(facts({ grid: grid({ applied: 0 }) })), 'out/grid-held');
  assert.equal(tierOf(facts({ grid: grid({ applied: -1 }) })), 'out/grid-reverted');
  assert.equal(tierOf(facts({ grid: grid({ status: 'unmeasurable', applied: 0, segments: [] }) })), 'out/grid-unmeasurable');
  assert.equal(tierOf(facts({ grid: grid({ status: 'failed', applied: 0, segments: [] }) })), 'out/grid-failed');
  // An applied grid on a row with no usable stored tempo: mixTempoOf null.
  assert.equal(tierOf(facts({ bpm: null })), 'out/grid-held');
  assert.equal(policy.readinessOf(facts({ grid: null })).mixBpm, null);
});

test('safe: a Hot Mix tempo, but no segment the seam planner trusts', () => {
  assert.equal(tierOf(facts({ grid: grid({ segments: [{ ...SEG, downbeatMs: null }] }) })), 'safe/no-trusted-bars');
  assert.equal(tierOf(facts({ grid: grid({ segments: [{ ...SEG, beats: 7 }] }) })), 'safe/no-trusted-bars');
  // A period 2 % off the grid's tempo (a double-time or drifting stretch).
  assert.equal(tierOf(facts({ grid: grid({ segments: [{ ...SEG, periodUs: Math.round(SEG.periodUs * 1.02) }] }) })), 'safe/no-trusted-bars');
  // At the edge: 8 beats and a period 0.9 % off is trusted.
  assert.equal(policy.readinessOf(facts({ grid: grid({ segments: [{ ...SEG, beats: 8, periodUs: Math.round(SEG.periodUs * 1.009) }] }) })).tier, 'phrase');
  assert.equal(policy.readinessOf(facts({ grid: grid({ segments: [{ ...SEG, downbeatMs: null }] }) })).mixBpm, 124);
});

test('beat: trusted bars, no phrase, by why', () => {
  assert.equal(tierOf(facts({ structure: null })), 'beat/structure-not-measured');
  // Bars the grid policy holds: no structure is measured on them.
  assert.equal(tierOf(facts({ structure: null, grid: grid({ downbeatAgreement: 0.5 }) })), 'beat/bars-held');
  assert.equal(tierOf(facts({ structure: null, grid: grid({ downbeatAgreement: 0.5, coverage: 0.5 }) })), 'beat/bars-held');
  // The half-bar case without a clear drop (bar line on beat 1 or 3).
  assert.equal(tierOf(facts({ structure: null, grid: grid({ downbeatAgreement: 0.5, downbeatHalfbar: 0.95, downbeatPhase: 'majority' }) })), 'beat/bars-half-bar');
  // A clear drop but too few beats on the grid: held for its coverage.
  assert.equal(tierOf(facts({ structure: null, grid: grid({ downbeatAgreement: 0.5, coverage: 0.5, downbeatHalfbar: 0.95, downbeatPhase: 'drop', downbeatDropDb: 20 }) })), 'beat/bars-held');
  // ... with a clear drop the bars are trusted, and the structure is simply due.
  assert.equal(tierOf(facts({ structure: null, grid: grid({ downbeatAgreement: 0.5, downbeatHalfbar: 0.95, downbeatPhase: 'drop', downbeatDropDb: 20 }) })), 'beat/structure-not-measured');
  assert.equal(tierOf(facts({ structure: structure({ gridAt: '2026-01-01T00:00:00.000Z' }) })), 'beat/structure-older-grid');
  assert.equal(tierOf(facts({ structure: structure({ status: 'unmeasurable', reason: 'odd-meter', bars: null }) })), 'beat/structure-unmeasurable/odd-meter');
  assert.equal(tierOf(facts({ structure: structure({ status: 'unmeasurable', reason: 'too-long', bars: null }) })), 'beat/structure-unmeasurable/too-long');
  assert.equal(tierOf(facts({ structure: structure({ status: 'failed', bars: null }) })), 'beat/structure-failed');
  // Measured on this grid, but no 16-bar full section: nothing to phrase on.
  assert.equal(tierOf(facts({ structure: structure({ bars: NO_FULL }) })), 'beat/no-full-section');
});

test('phrase: a structure on the current grid with a full section', () => {
  assert.equal(tierOf(facts()), 'phrase/phrase-both');
  // A 4-bar intro: it can leave on a phrase, not enter on one.
  assert.equal(tierOf(facts({ structure: structure({ bars: bars(4) }) })), 'phrase/phrase-out-only');
  assert.equal(policy.readinessOf(facts()).mixBpm, 124);
});

test('the bars are parsed only for a track that reaches the phrase check', () => {
  let reads = 0;
  const lazy = (o: Partial<Facts> = {}): Facts => facts({
    structure: { status: 'ok', reason: null, gridAt: AT, get bars() { reads++; return bars(16); } },
    ...o,
  });
  policy.readinessOf(lazy({ grid: grid({ applied: 0 }) }));
  policy.readinessOf(lazy({ grid: grid({ segments: [{ ...SEG, downbeatMs: null }] }) }));
  assert.equal(reads, 0);
  assert.equal(policy.readinessOf(lazy()).tier, 'phrase');
  assert.ok(reads >= 1);
});

test('canEnterOnPhrase agrees with planPhraseWindow on the incoming intro', () => {
  // The outgoing side: a full section, then a 16-bar outro to leave over.
  const out = bars(16, 48);
  for (const k of ['kick', 'bass', 'mid'] as const) out[k].splice(48, 16, ...Array(16).fill(-20));
  const a = { points: structurePoints(out), runs: out.runs, cueInSec: 0, endSec: 10_000 };
  // At the longest phrase a show can ask for, the shallowest entry: the
  // intro's length, its depth (over 56 bars skipped: refused) and a groove
  // before the entry (refused) all say the same on both sides.
  const grooved = (intro: number) => {
    const b = bars(intro);
    for (const k of ['kick', 'bass', 'mid'] as const) b[k].fill(0, 0, 8);
    return b;
  };
  const cases: Array<[string, ReturnType<typeof bars>, boolean]> = [
    ['4', bars(4), false], ['7', bars(7), false], ['8', bars(8), true], ['9', bars(9), true], ['16', bars(16), true],
    ['88', bars(88), true], ['89', bars(89), false], ['96', bars(96), false], ['40 with a groove', grooved(40), false],
  ];
  for (const [name, b, enters] of cases) {
    const points = structurePoints(b);
    const v = planPhraseWindow({ bars: 32, a, b: { points, runs: b.runs, cueInSec: 0 } });
    assert.equal(canEnterOnPhrase(points, b.runs), v.ok, `intro ${name}`);
    assert.equal(v.ok, enters, `intro ${name}: ${JSON.stringify(v)}`);
  }
});

test('a show reaches what the show editor counts: curve ± step, octave-safe', () => {
  const hm = hotMixOf({ hotMix: { enabled: true, maxStepPct: 3, curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 128 }] } })!;
  assert.equal(policy.inShowReach(116.5, hm), true);   // 120 - 2.9 %
  assert.equal(policy.inShowReach(116, hm), false);    // 120 - 3.3 %
  assert.equal(policy.inShowReach(131.8, hm), true);   // 128 + 3 %
  assert.equal(policy.inShowReach(132, hm), false);
  assert.equal(policy.inShowReach(62, hm), true);      // half time of 124
  assert.equal(policy.inShowReach(250, hm), true);     // double time of 125
  assert.equal(policy.inShowReach(null, hm), false);
  const free = hotMixOf({ hotMix: { enabled: true, maxStepPct: 3 } })!;
  assert.equal(policy.inShowReach(90, free), true, 'no curve: every known tempo');
  assert.equal(policy.inShowReach(null, free), false);
});

test('the tally: tiers, parts, stems, and per show only Hot Mix tempos in reach', () => {
  const hm = hotMixOf({ hotMix: { enabled: true, maxStepPct: 3, curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 128 }] } })!;
  const show = { id: 's', name: 'S', hm, tiers: policy.emptyShowTiers(), outByStoredTempo: 0 };
  const t = new policy.ReadinessTally([show]);
  t.add(policy.readinessOf(facts()), { stems: true, storedBpm: 124 });
  t.add(policy.readinessOf(facts({ bpm: 100, grid: grid({ bpm: 100, segments: [{ ...SEG, periodUs: 600_000 }] }) })), { stems: false, storedBpm: 100 });
  t.add(policy.readinessOf(facts({ structure: null })), { stems: false, storedBpm: 124 });
  t.add(policy.readinessOf(facts({ grid: grid({ applied: 0 }) })), { stems: true, storedBpm: 123.05 });
  t.add(policy.readinessOf(facts({ bpm: 99.4, grid: null })), { stems: false, storedBpm: 99.4 });
  const r = t.result();
  assert.equal(t.library, 5);
  assert.deepEqual(r.map((x) => [x.tier, x.tracks, x.stems]), [['phrase', 2, 1], ['beat', 1, 0], ['safe', 0, 0], ['out', 2, 1]]);
  assert.deepEqual(r[3].parts.map((p) => p.part).sort(), ['grid-held', 'no-grid']);
  // The 100 BPM phrase track is out of reach; the held 123.05 counts only by its stored tempo.
  assert.deepEqual(show.tiers, { phrase: 1, beat: 1, safe: 0 });
  assert.equal(show.outByStoredTempo, 1);
});

// ── The pass, on a real library ─────────────────────────────────────────────

const d = () => db.requireDb();

function seedTrack(id: string, o: { bpm?: number | null; stems?: boolean; grid?: Partial<Grid> | null; structure?: Partial<NonNullable<Facts['structure']>> | null } = {}) {
  d().prepare('INSERT INTO tracks (id, title, artist, album, bpm, stems_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `T ${id}`, 'A', 'B', o.bpm === undefined ? 124 : o.bpm, o.stems ? AT : null);
  if (o.grid !== null) {
    const g = grid(o.grid ?? {});
    d().prepare(`INSERT INTO track_grid (track_id, status, version, attempts, bpm, beats_per_bar, segments_json, coverage,
        downbeat_agreement, downbeat_halfbar, downbeat_drop_db, downbeat_phase, decoded_ms, measured_at, applied)
      VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, g.status, g.bpm, g.beatsPerBar, JSON.stringify(g.segments), g.coverage, g.downbeatAgreement,
        g.downbeatHalfbar, g.downbeatDropDb, g.downbeatPhase, g.decodedMs, g.measuredAt, g.applied);
  }
  if (o.structure !== null && o.grid !== null) {
    const s = structure(o.structure ?? {});
    d().prepare(`INSERT INTO track_structure (track_id, status, version, reason, attempts, measured_at, grid_at, bars_json)
      VALUES (?, ?, 1, ?, 0, ?, ?, ?)`)
      .run(id, s.status, s.reason, AT, s.gridAt, s.bars ? JSON.stringify(s.bars) : null);
  }
}

async function setShows(shows: Array<Record<string, unknown>>) {
  await settings.update({ shows: shows.map((s) => ({ personaId: settings.get().personas[0].id, ...s })) } as never);
}

beforeEach(async () => {
  d().exec('DELETE FROM tracks; DELETE FROM track_grid; DELETE FROM track_structure;');
  await setShows([]);
  pass._reset();
});

function seedLibrary() {
  seedTrack('p1', { stems: true });                                     // phrase, 124
  seedTrack('p2', { structure: { bars: bars(4) } });                    // phrase (out only)
  seedTrack('b1', { bpm: 100, grid: { bpm: 100, segments: [{ ...SEG, periodUs: 600_000 }] }, structure: null }); // beat, 100
  seedTrack('b2', { structure: { status: 'unmeasurable', reason: 'odd-meter', bars: null } });
  seedTrack('s1', { grid: { segments: [{ ...SEG, downbeatMs: null }] }, structure: null }); // safe
  seedTrack('o1', { bpm: 123.05, grid: { applied: 0 }, structure: null });                   // out: held
  seedTrack('o2', { bpm: 99.4, grid: null });                                               // out: no grid
}

test('the pass lands every tier, part, stem and show count in one snapshot', async () => {
  seedLibrary();
  await setShows([
    { id: 'house', name: 'House', hotMix: { enabled: true, maxStepPct: 3, phraseMix: true, curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 126 }] } },
    { id: 'free', name: 'Free', hotMix: { enabled: true, maxStepPct: 3 } },
    { id: 'plain', name: 'Plain' },
  ]);
  const r = await pass.countTransitionReadiness();
  assert.equal(r.library, 7);
  assert.deepEqual(r.tiers.map((t) => [t.tier, t.tracks, t.stems]), [['phrase', 2, 1], ['beat', 2, 0], ['safe', 1, 0], ['out', 2, 0]]);
  assert.deepEqual(r.tiers[1].parts.map((p) => [p.part, p.reason, p.tracks]),
    [['structure-not-measured', null, 1], ['structure-unmeasurable', 'odd-meter', 1]]);
  assert.deepEqual(r.tiers[0].parts.map((p) => p.part), ['phrase-both', 'phrase-out-only']);
  assert.deepEqual(r.shows.map((s) => s.id), ['house', 'free'], 'only Hot Mix shows get a column');
  const house = r.shows[0];
  assert.deepEqual(house.curve, { lo: 120, hi: 126 });
  assert.equal(house.phraseMix, true);
  assert.deepEqual(house.tiers, { phrase: 2, beat: 1, safe: 1 });
  assert.equal(house.outByStoredTempo, 1);
  assert.equal(r.shows[1].curve, null);
  assert.deepEqual(r.shows[1].tiers, { phrase: 2, beat: 2, safe: 1 });
  assert.ok(transitionReadinessResponseSchema.safeParse({ readiness: r }).success);
});

test('the tracks side walks its covering index, never the wide rows', () => {
  const plan = (d().prepare(`EXPLAIN QUERY PLAN ${pass.TRANSITION_ROWS_SQL}`).all('', 10) as Array<{ detail: string }>)
    .map((p) => p.detail).join(' | ');
  assert.match(plan, /SCAN t USING COVERING INDEX idx_tracks_transitions|SEARCH t USING COVERING INDEX idx_tracks_transitions/);
  assert.match(plan, /SEARCH g USING PRIMARY KEY/);
  assert.match(plan, /SEARCH s USING PRIMARY KEY/);
});

test('the pass reads in chunks: more tracks than one chunk all count', async () => {
  const ins = d().prepare('INSERT INTO tracks (id, title, bpm) VALUES (?, ?, ?)');
  d().transaction(() => { for (let i = 0; i < 4500; i++) ins.run(`n${String(i).padStart(5, '0')}`, 't', 120); })();
  const r = await pass.countTransitionReadiness();
  assert.equal(r.library, 4500);
  assert.equal(r.tiers[3].tracks, 4500);
});

test('the read route never counts: null first, the pass after, then the snapshot', async () => {
  seedLibrary();
  const app = express();
  app.use(maintenance);
  const srv = await listen(app);
  const auth = { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'x-subwave-console': '1' };
  try {
    const first = await fetch(`${srv.url}/library/transitions`, { headers: auth });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { readiness: null });
    await pass._settled();
    assert.equal(pass._passes(), 1);
    const second = await (await fetch(`${srv.url}/library/transitions`, { headers: auth })).json();
    const parsed = transitionReadinessResponseSchema.parse(second);
    assert.equal(parsed.readiness?.library, 7);
    // Fresh and unchanged: a third read starts nothing.
    await fetch(`${srv.url}/library/transitions`, { headers: auth });
    await pass._settled();
    assert.equal(pass._passes(), 1);
  } finally {
    await srv.close();
  }
});

test('a look never counts in its own turn', async () => {
  seedLibrary();
  assert.equal(pass.getTransitionReadiness(), null);
  assert.equal(pass._passes(), 0, 'nothing counted before the look returned');
  await pass._settled();
  assert.equal(pass._passes(), 1);
  assert.equal(pass.getTransitionReadiness()?.library, 7);
});

test('a stale look recounts only when an input moved; a Hot Mix show change is seen at once', async () => {
  seedLibrary();
  pass.getTransitionReadiness();
  await pass._settled();
  assert.equal(pass._passes(), 1);
  // Past the TTL with nothing moved: the look reads the inputs' key and keeps the counts.
  pass.getTransitionReadiness(Date.now() + 31 * 60_000);
  await pass._settled();
  assert.equal(pass._passes(), 1);
  // A grid lands: the library committed, and a look a minute on recounts.
  d().prepare('UPDATE track_grid SET applied = 1 WHERE track_id = ?').run('o1');
  pass.getTransitionReadiness(Date.now() + 61_000);
  await pass._settled();
  assert.equal(pass._passes(), 2);
  assert.equal(pass.getTransitionReadiness()?.tiers[3].tracks, 1);
  // A Hot Mix show is added: seen on the next look, without the minute.
  await setShows([{ id: 'house', name: 'House', hotMix: { enabled: true, maxStepPct: 3, curve: [{ at: 0, bpm: 120 }] } }]);
  pass.getTransitionReadiness();
  await pass._settled();
  assert.equal(pass._passes(), 3);
  assert.deepEqual(pass.getTransitionReadiness()?.shows.map((s) => s.id), ['house']);
});
