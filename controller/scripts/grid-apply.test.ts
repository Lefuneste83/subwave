// The beat grid written over the head analysis (tracks.applyGridToTrack,
// music/grid-policy.ts; F17 step 4). Pinned:
//   - a grid passing the gate replaces bpm, and beats + bars over the head
//     window when the downbeats agree; the head's own values are kept;
//   - bpm passing with bars held keeps the head's beats AND bars together;
//   - a held grid writes nothing;
//   - a later head re-analysis can't undo it: the fresh head values become the
//     kept ones and the grid goes over them again;
//   - a grid re-measured as unmeasurable gives the head's values back;
//   - revert restores and stays reverted through a re-analysis until a forced
//     apply; a failed grid attempt changes nothing;
//   - a moved tempo word marks the text vector, an unmoved one doesn't;
//   - the window and bar arithmetic.
// Run: `npm test -- grid-apply`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-grid-apply-'));
process.env.STATE_DIR = stateDir;
const db = await import('../src/music/library-db.js');
const P = await import('../src/music/grid-policy.js');
const { soundWords, trackAcoustics } = await import('../src/music/sound-line.js');
const DIM = 8;
await db.open({ embeddingDim: DIM, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

// 124 BPM, 4/4, downbeat on the first beat at 480 ms, the whole 340 s track.
const PERIOD = 483.871;
const SEG = { anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 };
const answer = (over: Record<string, unknown> = {}) => ({
  version: 1, engine: 'beat_this', model: 'final0', bpm: 124, beatsPerBar: 4, segments: [SEG],
  coverage: 0.97, residualMs: 5, downbeatAgreement: 0.84, mainShare: 0.99, decodedMs: 340_000, ...over,
}) as import('../src/music/library-db/grid.js').GridAnswer;

// librosa's head: 62 BPM (an octave low), its own beats and bars over 40 s.
const HEAD_BEATS = Array.from({ length: 40 }, (_, i) => Math.round(500 + i * 967.7)).filter((b) => b <= 38_000);
const HEAD_BARS = HEAD_BEATS.filter((_, i) => i % 4 === 1);
function seed(id: string, bpm = 62) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
  db.upsertTrackAnalysis(id, { bpm, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, source: 'full' } as never);
  const v = new Float32Array(DIM); v[0] = 1;
  db.upsertTrackVector(id, v, null, soundWords(trackAcoustics(db.getTrack(id)!)));
  clearDirty(id);
}
const row = (id: string) => db.requireDb().prepare('SELECT bpm, beats_json, bars_json, text_vector_dirty FROM tracks WHERE id = ?').get(id) as
  { bpm: number | null; beats_json: string | null; bars_json: string | null; text_vector_dirty: number };
const clearDirty = (id: string) => db.requireDb().prepare('UPDATE tracks SET text_vector_dirty = 0 WHERE id = ?').run(id);
const grid = (id: string) => db.getGrid(id)!;

test('a passing grid replaces bpm, beats and bars over the head window; the head is kept', () => {
  seed('a1');
  db.writeGridResult('a1', { grid: answer() });
  const r = row('a1');
  assert.equal(r.bpm, 124);
  const beats = JSON.parse(r.beats_json!) as number[];
  const bars = JSON.parse(r.bars_json!) as number[];
  assert.equal(beats[0], 480);
  assert.ok(beats[beats.length - 1] <= Math.max(...HEAD_BEATS), 'within the head window');
  assert.ok(Math.abs(beats[1] - beats[0] - PERIOD) < 1);
  assert.deepEqual(bars.slice(0, 3), [480, Math.round(480 + 4 * PERIOD), Math.round(480 + 8 * PERIOD)]);
  const g = grid('a1');
  assert.equal(g.applied, 1);
  assert.equal(g.headBpm, 62);
  assert.deepEqual(JSON.parse(g.headBeatsJson!), HEAD_BEATS);
  assert.deepEqual(JSON.parse(g.headBarsJson!), HEAD_BARS);
  assert.equal(r.text_vector_dirty, 1, 'slow → upbeat: the tempo word moved');
});

test('bpm passing with the bars held keeps the head\'s beats and bars together', () => {
  seed('a2');
  db.writeGridResult('a2', { grid: answer({ downbeatAgreement: 0.56 }) });
  const r = row('a2');
  assert.equal(r.bpm, 124);
  assert.deepEqual(JSON.parse(r.beats_json!), HEAD_BEATS);
  assert.deepEqual(JSON.parse(r.bars_json!), HEAD_BARS);
  assert.equal(grid('a2').applied, 1);
});

test('a held grid writes nothing', () => {
  seed('a3');
  db.writeGridResult('a3', { grid: answer({ coverage: 0.6 }) });
  assert.equal(row('a3').bpm, 62);
  assert.equal(grid('a3').applied, 0);
  assert.equal(row('a3').text_vector_dirty, 0);
  seed('a3b');
  db.writeGridResult('a3b', { grid: answer({ bpm: 219.99, segments: [{ anchorMs: 480, periodUs: 272748, beats: 1240, downbeatMs: 480 }] }) });
  assert.equal(row('a3b').bpm, 62, 'above 200: held, never halved');
});

test('an unmoved tempo word marks nothing', () => {
  seed('a4', 123.05);
  db.writeGridResult('a4', { grid: answer() });
  assert.equal(row('a4').bpm, 124);
  assert.equal(row('a4').text_vector_dirty, 0);
});

test('a head re-analysis keeps the grid on top, its fresh values kept', () => {
  seed('a5');
  db.writeGridResult('a5', { grid: answer() });
  db.upsertTrackAnalysis('a5', { bpm: 63, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, source: 'full' } as never);
  assert.equal(row('a5').bpm, 124);
  assert.equal(grid('a5').headBpm, 63);
  // The facet path's head write too.
  db.writeFacetResults('a5', { head: { bpm: 64, musicalKey: '8A', beats: HEAD_BEATS, bars: HEAD_BARS } as never, source: 'url' } as never);
  assert.equal(row('a5').bpm, 124);
  assert.equal(grid('a5').headBpm, 64);
});

test('a grid re-measured as unmeasurable gives the head back; a failed attempt changes nothing', () => {
  seed('a6');
  db.writeGridResult('a6', { grid: answer() });
  db.writeGridResult('a6', { failed: 'sidecar 500' });
  assert.equal(row('a6').bpm, 124, 'a failure says nothing against the grid');
  db.writeGridResult('a6', { version: 1, unmeasurable: 'no-beat' });
  const r = row('a6');
  assert.equal(r.bpm, 62);
  assert.deepEqual(JSON.parse(r.beats_json!), HEAD_BEATS);
  assert.deepEqual(JSON.parse(r.bars_json!), HEAD_BARS);
  assert.equal(grid('a6').applied, 0);
});

test('revert restores, survives a re-analysis and a re-measure, and a forced apply undoes it', () => {
  seed('a7');
  db.writeGridResult('a7', { grid: answer() });
  clearDirty('a7');
  assert.equal(db.revertGridOnTrack('a7'), true);
  assert.equal(row('a7').bpm, 62);
  assert.deepEqual(JSON.parse(row('a7').bars_json!), HEAD_BARS);
  assert.equal(grid('a7').applied, -1);
  // The vector was built at 62 BPM: back to its own words, nothing to re-embed
  // (the mark compares with the vector's words, never the row before).
  assert.equal(row('a7').text_vector_dirty, 0);
  db.upsertTrackAnalysis('a7', { bpm: 62, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, source: 'full' } as never);
  db.writeGridResult('a7', { grid: answer() });
  assert.equal(row('a7').bpm, 62, 'reverted stays reverted');
  assert.equal(db.applyGridToTrack('a7'), 'reverted');
  assert.equal(db.applyGridToTrack('a7', { force: true }), 'applied');
  assert.equal(row('a7').bpm, 124);
  assert.deepEqual(db.gridIdsApplied(1).includes('a7'), true);
});

test('a library re-analysis clear forgets the kept head; the next head write re-applies', () => {
  seed('a8');
  db.writeGridResult('a8', { grid: answer() });
  db.clearAnalysis();
  assert.equal(row('a8').bpm, null);
  assert.equal(grid('a8').applied, 0);
  db.upsertTrackAnalysis('a8', { bpm: 61, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, source: 'full' } as never);
  assert.equal(row('a8').bpm, 124);
  assert.equal(grid('a8').headBpm, 61);
});

test('an ID rotation carries the kept head with the grid', () => {
  seed('a9');
  db.writeGridResult('a9', { grid: answer() });
  const d = db.requireDb();
  db.moveGridRow(d, 'a9', 'a9-new');
  const g = db.getGrid('a9-new')!;
  assert.equal(g.applied, 1);
  assert.equal(g.headBpm, 62);
  assert.equal(db.getGrid('a9'), null);
});

test('window and bar arithmetic', () => {
  assert.equal(P.headWindowEndMs([100, 200], [150, 900]), 900);
  assert.equal(P.headWindowEndMs(null, null), P.DEFAULT_HEAD_WINDOW_MS);
  assert.deepEqual(P.gridBeatsWithin([{ anchorMs: 0, periodUs: 500000, beats: 10, downbeatMs: 0 }], 1600), [0, 500, 1000, 1500]);
  // Downbeat on the 2nd beat; bars before it in the segment are kept too.
  assert.deepEqual(P.gridBarsWithin([{ anchorMs: 0, periodUs: 500000, beats: 20, downbeatMs: 500 }], 4, 9000), [500, 2500, 4500, 6500, 8500]);
  assert.deepEqual(P.gridBarsWithin([{ anchorMs: 0, periodUs: 500000, beats: 20, downbeatMs: null }], 4, 9000), []);
  // Two segments: each its own phase, nothing past a segment's end.
  assert.deepEqual(P.gridBarsWithin([
    { anchorMs: 0, periodUs: 500000, beats: 9, downbeatMs: 0 },
    { anchorMs: 5000, periodUs: 500000, beats: 9, downbeatMs: 5500 },
  ], 4, 20_000), [0, 2000, 4000, 5500, 7500]);
  assert.equal(P.gridDecision(null).bpm, false);
});
