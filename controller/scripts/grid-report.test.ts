// The beat grid's dry-run report (music/grid-report.ts). Pinned:
//   - the tempo relation names octave and 3:2 errors, and nothing within 2 %
//     counts as a different tempo;
//   - a tempo-word change is exactly soundWords()' change (the embed text's
//     own rule), and only counts as a re-embed when the gate would write it;
//   - the gate holds a grid the model was not confident about (coverage, the
//     main tempo's share), and holds bars when the downbeats split;
//   - a stored bar line's offset is measured on the grid in beats from the
//     nearest downbeat;
//   - the CLI reads only: the library is byte-identical after a run.
// Run: `npm test -- grid-report`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-grid-report-'));
process.env.STATE_DIR = stateDir;
const R = await import('../src/music/grid-report.js');
const C = await import('../src/music/grid-report-cli.js');
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

// 124 BPM: period 483.871 ms, 4/4, downbeat on the first beat at 480 ms.
const grid = (over: Partial<import('../src/music/library-db/grid.js').TrackGrid> = {}) => ({
  status: 'ok' as const, version: 1, reason: null, attempts: 0, engine: 'beat_this', model: 'final0',
  bpm: 124, beatsPerBar: 4,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  coverage: 0.97, residualMs: 5, downbeatAgreement: 0.84, mainShare: 0.99, decodedMs: 340_000,
  measuredAt: '2026-11-12T00:00:00Z', applied: 0 as const, headBpm: null, headBeatsJson: null, headBarsJson: null, headOutroJson: null, gridOutroJson: null, ...over,
});
const P = 483.871;
const track = (over: Partial<Parameters<typeof R.compareGrid>[0]> = {}) => ({
  id: 't', artist: 'A', title: 'T', genres: ['techno'], bpm: 123.05 as number | null, musicalKey: '8A', audioMoods: [] as string[],
  vocalRanges: [], vocalRangesInvalid: false, tailVocalRanges: [], tailVocalRangesInvalid: false,
  beats: Array.from({ length: 16 }, (_, i) => Math.round(480 + i * P)),
  bars: [480, Math.round(480 + 4 * P)],
  ...over,
});

test('tempo relations', () => {
  assert.equal(R.tempoRelation(123.05, 124), 'same');
  assert.equal(R.tempoRelation(62, 124), 'double');
  assert.equal(R.tempoRelation(248, 124), 'half');
  assert.equal(R.tempoRelation(82.7, 124), 'three-halves');
  assert.equal(R.tempoRelation(186, 124), 'two-thirds');
  assert.equal(R.tempoRelation(100, 124), 'other');
  assert.equal(R.tempoRelation(null, 124), 'no-stored-bpm');
  assert.equal(R.tempoRelation(0, 124), 'no-stored-bpm');
});

test('a quantised tempo corrected inside its band moves no word', () => {
  const r = R.compareGrid(track(), grid())!;
  assert.equal(r.relation, 'same');
  assert.equal(r.deltaBpm, 0.95);
  assert.equal(r.reEmbed, false);
  assert.equal(r.wordsBefore, r.wordsAfter);
  assert.equal(r.wouldWriteBpm, true);
  assert.equal(r.heldBecause, null);
});

test('an octave error is named, and its word change is a re-embed', () => {
  const r = R.compareGrid(track({ bpm: 62 }), grid())!;
  assert.equal(r.relation, 'double');
  assert.match(r.wordsBefore, /slow tempo/);
  assert.match(r.wordsAfter, /upbeat tempo/);
  assert.equal(r.reEmbed, true);
});

test('a band edge crossed by a small correction is a re-embed too', () => {
  const r = R.compareGrid(track({ bpm: 104.4 }), grid({ bpm: 105.2, segments: [{ anchorMs: 480, periodUs: 570342, beats: 600, downbeatMs: 480 }] }))!;
  assert.equal(r.relation, 'same');
  assert.equal(r.reEmbed, true, 'mid-tempo → upbeat tempo');
});

test('the gate holds an unconfident grid, and its word change is no re-embed', () => {
  const low = R.compareGrid(track({ bpm: 62 }), grid({ coverage: 0.6 }))!;
  assert.equal(low.wouldWriteBpm, false);
  assert.equal(low.wouldWriteBars, false);
  assert.equal(low.reEmbed, false);
  assert.match(low.heldBecause ?? '', /coverage 0.6/);
  const fast = R.compareGrid(track({ bpm: 73.8 }), grid({ bpm: 219.99 }))!;
  assert.equal(fast.wouldWriteBpm, false, 'above 200 BPM: held, never halved');
  assert.match(fast.heldBecause ?? '', /above 200: possibly double time/);
  assert.equal(R.compareGrid(track({ bpm: 184.6 }), grid({ bpm: 187.7, segments: [{ anchorMs: 480, periodUs: 319659, beats: 1060, downbeatMs: 480 }] }))!.wouldWriteBpm, true);
  // Two segments at 124 and 30 s of something else in 340 s: 0.3 steady.
  const split = R.compareGrid(track(), grid({ segments: [
    { anchorMs: 480, periodUs: 483871, beats: 200, downbeatMs: 480 },
    { anchorMs: 100_000, periodUs: 600000, beats: 300, downbeatMs: 100_000 },
  ] }))!;
  assert.equal(split.wouldWriteBpm, false);
  assert.match(split.heldBecause ?? '', /steady tempo on 0.28 of the track/);
  // A steady song split by small drifts (live drums) is written: its segments
  // all sit within 4 % of the main tempo.
  const drift = R.compareGrid(track(), grid({ mainShare: 0.3, segments: [
    { anchorMs: 480, periodUs: 483871, beats: 200, downbeatMs: 480 },
    { anchorMs: 98_000, periodUs: 490000, beats: 200, downbeatMs: 98_000 },
    { anchorMs: 196_000, periodUs: 478000, beats: 280, downbeatMs: 196_000 },
  ] }))!;
  assert.equal(drift.steadyShare, 0.96);
  assert.equal(drift.wouldWriteBpm, true);
});

test('bars are held when the downbeats split, written when they agree', () => {
  assert.equal(R.compareGrid(track(), grid({ downbeatAgreement: 0.56 }))!.wouldWriteBars, false);
  assert.match(R.compareGrid(track(), grid({ downbeatAgreement: 0.56 }))!.heldBecause ?? '', /downbeat agreement 0.56/);
  assert.equal(R.compareGrid(track(), grid())!.wouldWriteBars, true);
  assert.equal(R.compareGrid(track(), grid({ beatsPerBar: null }))!.wouldWriteBars, false);
});

test('a stored bar line is placed on the grid in beats from the nearest downbeat', () => {
  assert.equal(R.compareGrid(track(), grid())!.barOffsetBeats, 0);
  assert.equal(R.compareGrid(track(), grid())!.barShift, false);
  const oneOff = R.compareGrid(track({ bars: [Math.round(480 + P)] }), grid())!;
  assert.equal(oneOff.barOffsetBeats, 1);
  assert.equal(oneOff.barShift, true);
  const threeOff = R.compareGrid(track({ bars: [Math.round(480 + 3 * P)] }), grid())!;
  assert.equal(threeOff.barOffsetBeats, -1, 'the nearest downbeat is one beat later');
  const halfBeat = R.compareGrid(track({ bars: [Math.round(480 + P / 2)] }), grid())!;
  assert.equal(halfBeat.barOffsetBeats, 0.5);
  assert.equal(R.compareGrid(track({ bars: null }), grid())!.barOffsetBeats, null);
  assert.equal(R.barOffsetBeats({ segments: grid().segments, beatsPerBar: 4 }, 10_000_000), null, 'outside the grid');
});

test('today\'s head beats read against the whole-track grid', () => {
  assert.equal(R.storedBeatsOnGrid(grid().segments, track().beats ?? []), 1);
  // librosa's quantised 123.05 BPM walks off a 124 BPM grid.
  const drifting = Array.from({ length: 80 }, (_, i) => Math.round(480 + i * (60000 / 123.05)));
  assert.ok(R.storedBeatsOnGrid(grid().segments, drifting)! < 0.5);
  assert.equal(R.storedBeatsOnGrid(grid().segments, []), null);
});

test('the summary counts and the CSV', () => {
  const rows = [
    R.compareGrid(track(), grid())!,
    R.compareGrid(track({ id: 'b', bpm: 62, title: 'Hello, "World"' }), grid())!,
    R.compareGrid(track({ id: 'c', bpm: 62 }), grid({ coverage: 0.5 }))!,
  ];
  const s = R.summariseGridReport(rows);
  assert.equal(s.tracks, 3);
  assert.equal(s.byRelation.same, 1);
  assert.equal(s.byRelation.double, 2);
  assert.equal(s.wouldWriteBpm, 2);
  assert.equal(s.held, 1);
  assert.equal(s.reEmbeds, 1);
  assert.equal(s.bpmChangesOver1, 1);
  const csv = R.gridReportCsv(rows);
  assert.match(csv.split('\r\n')[0], /^id,artist,title,genre,storedBpm,gridBpm/);
  assert.ok(csv.includes('"Hello, ""World"""'));
  assert.equal(csv.split('\r\n').length, 5);
  assert.ok(C.formatSummary(rows).some((l) => /tempo corrections the gate would write/.test(l)));
});

test('the report reads only: the library file is unchanged', () => {
  db.upsertTrackMeta('lib1', { title: 'L', artist: 'A', album: 'B', duration: 300 } as never);
  db.upsertTrackAnalysis('lib1', { bpm: 62, musicalKey: '8A', loudnessLufs: -9, source: 'full' } as never);
  db.writeGridResult('lib1', { grid: { version: 1, engine: 'beat_this', model: 'final0', bpm: 124, beatsPerBar: 4,
    segments: grid().segments, coverage: 0.97, residualMs: 5, downbeatAgreement: 0.84, mainShare: 0.99, decodedMs: 300_000 } });
  db.requireDb().pragma('wal_checkpoint(TRUNCATE)');
  const file = join(stateDir, 'library.db');
  const before = readFileSync(file);
  const rows = db.allMeasuredGrids().map(({ id, grid: g }) => R.compareGrid(R.withHeadValues({ ...db.getTrack(id)!, id }, g), g)!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relation, 'double');
  db.requireDb().pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(readFileSync(file).equals(before));
});
