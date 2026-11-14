// The beat grid written over the head analysis (tracks.applyGridToTrack,
// music/grid-policy.ts). Pinned:
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

test('--reembed-moved marks only an unknown-words vector whose tempo word the grid moved', () => {
  const plain = (id: string, bpm: number) => {
    db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
    db.upsertTrackAnalysis(id, { bpm, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, source: 'full' } as never);
    const v = new Float32Array(DIM); v[0] = 1;
    db.upsertTrackVector(id, v, null); // built before the words were stored: unknown
    clearDirty(id);
  };
  plain('r1', 62);
  db.writeGridResult('r1', { grid: answer() });
  assert.equal(row('r1').text_vector_dirty, 0, 'the measurement rule never marks an unknown vector');
  assert.equal(db.markGridMovedVectorIfUnknown('r1', true), true, 'dry run says it would');
  assert.equal(row('r1').text_vector_dirty, 0, 'and writes nothing');
  assert.equal(db.markGridMovedVectorIfUnknown('r1'), true);
  assert.equal(row('r1').text_vector_dirty, 1);
  plain('r2', 123.05);
  db.writeGridResult('r2', { grid: answer() });
  assert.equal(db.markGridMovedVectorIfUnknown('r2'), false, 'upbeat both before and after');
  // A known vector is the measurement rule's (a1-like, seeded with its words).
  seed('r3');
  db.writeGridResult('r3', { grid: answer() });
  clearDirty('r3');
  assert.equal(db.markGridMovedVectorIfUnknown('r3'), false);
  // Not applied (held): nothing.
  plain('r4', 62);
  db.writeGridResult('r4', { grid: answer({ coverage: 0.5 }) });
  assert.equal(db.markGridMovedVectorIfUnknown('r4'), false);
});

// The ending (outro_json bpm/beats/bars): the tail measurement read 61 BPM
// near the end, with bars every 4th beat from an arbitrary phase.
const TAIL_BEATS = Array.from({ length: 30 }, (_, i) => Math.round(310_000 + i * 983.6)).filter((b) => b < 339_000);
const TAIL_BARS = TAIL_BEATS.filter((_, i) => i % 4 === 2);
const OUTRO = { startMs: 312_000, ending: 'fade', lufs: -14.5, bpm: 61, beats: TAIL_BEATS, bars: TAIL_BARS, vocalRanges: [] };
const outroOf = (id: string) => JSON.parse((db.requireDb().prepare('SELECT outro_json FROM tracks WHERE id = ?').get(id) as { outro_json: string }).outro_json);
function seedWithOutro(id: string, outro: Record<string, unknown> = OUTRO) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
  db.upsertTrackAnalysis(id, { bpm: 62, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, outro, source: 'full' } as never);
}

test('the ending takes the grid\'s tempo, beats and bars; every other outro field stays', () => {
  seedWithOutro('o1');
  db.writeGridResult('o1', { grid: answer() });
  const o = outroOf('o1');
  assert.equal(o.bpm, 124);
  assert.equal(o.ending, 'fade');
  assert.equal(o.lufs, -14.5);
  assert.deepEqual(o.vocalRanges, []);
  assert.equal(o.startMs, 312_000);
  assert.ok(o.beats[0] >= TAIL_BEATS[0] && o.beats[0] - TAIL_BEATS[0] < PERIOD, 'from the first kept tail beat');
  assert.ok(Math.abs(o.beats[1] - o.beats[0] - PERIOD) < 1);
  // Bars on the grid's downbeat phase (480 + 4k periods), not every 4th detection.
  for (const b of o.bars) assert.ok(Math.abs(((b - 480) / PERIOD) % 4) < 0.01 || Math.abs(((b - 480) / PERIOD) % 4 - 4) < 0.01, `bar ${b}`);
  const g = db.getGrid('o1')!;
  assert.deepEqual(JSON.parse(g.headOutroJson!), { bpm: 61, beats: TAIL_BEATS, bars: TAIL_BARS });
});

test('the ending: bars held keeps its beats and bars, tempo still the grid\'s', () => {
  seedWithOutro('o2');
  db.writeGridResult('o2', { grid: answer({ downbeatAgreement: 0.5 }) });
  const o = outroOf('o2');
  assert.equal(o.bpm, 124);
  assert.deepEqual(o.beats, TAIL_BEATS);
  assert.deepEqual(o.bars, TAIL_BARS);
});

test('the ending keeps its own tempo when the grid slows down there', () => {
  seedWithOutro('o3');
  db.writeGridResult('o3', { grid: answer({ mainShare: 0.9, segments: [
    { anchorMs: 480, periodUs: 483871, beats: 620, downbeatMs: 480 },        // to ~300 s at 124
    { anchorMs: 300_500, periodUs: 500000, beats: 79, downbeatMs: 300_500 },  // 120 BPM outro
  ] }) });
  assert.equal(row('o3').bpm, 124);
  assert.equal(outroOf('o3').bpm, 120);
});

test('a fresh tail measurement is kept and covered again; revert restores it', () => {
  seedWithOutro('o4');
  db.writeGridResult('o4', { grid: answer() });
  const fresh = { ...OUTRO, bpm: 60.5, lufs: -15 };
  db.upsertTrackAnalysis('o4', { bpm: 62, musicalKey: '8A', loudnessLufs: -9, beats: HEAD_BEATS, bars: HEAD_BARS, outro: fresh, source: 'full' } as never);
  assert.equal(outroOf('o4').bpm, 124, 'covered again');
  assert.equal(outroOf('o4').lufs, -15, 'the fresh measurement\'s other fields land');
  assert.equal(JSON.parse(db.getGrid('o4')!.headOutroJson!).bpm, 60.5, 'the fresh tempo is the kept one');
  assert.equal(db.revertGridOnTrack('o4'), true);
  const o = outroOf('o4');
  assert.deepEqual([o.bpm, o.beats, o.bars], [60.5, TAIL_BEATS, TAIL_BARS]);
  assert.equal(o.lufs, -15);
  assert.deepEqual([db.getGrid('o4')!.headOutroJson, db.getGrid('o4')!.gridOutroJson], [null, null]);
});

test('the ending goes back with the head when the grid no longer passes; held never touches it', () => {
  seedWithOutro('o5');
  db.writeGridResult('o5', { grid: answer() });
  db.writeGridResult('o5', { version: 1, unmeasurable: 'no-beat' });
  assert.deepEqual([outroOf('o5').bpm, outroOf('o5').bars], [61, TAIL_BARS]);
  seedWithOutro('o6');
  db.writeGridResult('o6', { grid: answer({ coverage: 0.5 }) });
  assert.deepEqual(outroOf('o6'), OUTRO);
  // No outro at all: nothing written, nothing kept.
  seed('o7');
  db.writeGridResult('o7', { grid: answer() });
  assert.equal(db.getGrid('o7')!.headOutroJson, null);
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
  assert.deepEqual(P.gridBeatsWithin([{ anchorMs: 0, periodUs: 500000, beats: 10, downbeatMs: 0 }], 3000, 1200), [1500, 2000, 2500, 3000]);
  assert.equal(P.gridTempoWithin([{ anchorMs: 0, periodUs: 500000, beats: 10, downbeatMs: 0 }], 0, 5000), 120);
  assert.equal(P.gridTempoWithin([{ anchorMs: 0, periodUs: 500000, beats: 10, downbeatMs: 0 }], 4200, 9000), null, 'under 4 beats covered');
});
