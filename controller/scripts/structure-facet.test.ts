// The per-bar musical structure on the controller side
// (library-db/structure.ts, the opt-in `structure` facet): storage, its own
// failure history, the derivation from the beat grid, the planner gate, the
// pass writing a structure-only plan, and the read-only report. Real
// better-sqlite3 DB in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub.
//
// Pinned here (the operator's rules: an upgrade changes nothing a station
// plays, the facet is opt-in, and it is measured only on a grid whose bars are
// trusted):
//   - adding the facet re-derives the facet table to the same rows for every
//     track without a grid; a grid whose bars are not trusted settles the
//     structure as `unmeasurable / no-bars` (never sent to the analyzer), and
//     a track with no grid row has no structure row and is not due;
//   - the analyzer's answer is parsed strictly (one array length, the runs
//     adding up to it): a malformed one is a failed attempt;
//   - a structure write never touches the track's analysis failure history,
//     and a structure failure never counts against it; an ok row survives a
//     later failed attempt;
//   - a re-measured grid makes the stored structure outdated (due again); a
//     grid that loses its bars settles it as no-bars, one that gains them
//     makes the track due;
//   - an unmeasurable structure (too long) is no "Needs you" item;
//   - a replaced file and a pruned track drop it; an ID rotation moves it (the
//     new id's own row wins); a re-derive drops orphan rows;
//   - the planner plans `structure` only on a positive capability, and the
//     regular run's model lane never plans it (its own Hot Mix step:
//     beat-grid-regular-run.test.ts);
//   - a structure-only plan streams by URL (no capped download), carries the
//     grid in the request, and writes the row; one that fails alone is
//     stamped on the structure row, never on analyze_fail_count;
//   - the report reads the hard-kick points off the stored arrays.
// Run: `npm test -- structure-facet`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const requests: Array<Record<string, unknown>> = [];
let structureAnswer: Record<string, unknown> = {};
let streamHits = 0;
const GOOD_GRID = {
  grid_version: 1, engine: 'beat_this', model: 'final0', bpm: 124.0, beats_per_bar: 4,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  coverage: 0.98, residual_ms: 5.2, downbeat_agreement: 0.84, main_share: 0.99,
  beats_detected: 712, decoded_ms: 340_000,
};
// 20 bars: a 4-bar intro on a soft kick, then the full section to the end.
const N = 20;
const GOOD_STRUCTURE = {
  structure_version: 1,
  runs: [[480, 1_935_484, N]],
  kick: [...Array(4).fill(-10), ...Array(N - 4).fill(0)],
  kicks: Array(N).fill(4),
  bass: [...Array(4).fill(-20), ...Array(N - 4).fill(-2)],
  mid: [...Array(4).fill(-8), ...Array(N - 4).fill(-1)],
  high: Array(N).fill(-3),
  level: Array(N).fill(-1),
  melody: Array(N).fill(6.5),
  decoded_ms: 340_000,
};

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_capable: true, analyze_grid_capable: false,
      analyze_structure_capable: true, analyze_whole_file_concurrency: 6,
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      res.setHeader('Content-Type', 'application/json');
      const facets: Record<string, unknown> = {};
      for (const f of r.facets ?? []) facets[f] = f === 'structure' ? structureAnswer : { status: 'ok', data: {} };
      res.end(JSON.stringify({ ok: true, facets, source: { kind: 'whole-file', duration_s: 340, complete: true } }));
    });
    return;
  }
  if (req.url?.startsWith('/rest/stream')) streamHits += 1;
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = createTempDir(join(tmpdir(), 'subwave-structure-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;

const db = await import('../src/music/library-db.js');
const P = await import('../src/music/acoustics-plan.js');
const R = await import('../src/music/regular-run-plan.js');
const analyzer = await import('../src/music/analyzer.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const overview = await import('../src/music/library-overview.js');
const report = await import('../src/music/structure-report.js');
const { gridDecision } = await import('../src/music/grid-policy.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const sql = () => db.requireDb();

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
  await removeTempDir(stateDir);
});

type Row = { status: string; version: number; reason: string | null; attempts: number };
const facetRow = (id: string, facet = 'structure') =>
  sql().prepare('SELECT status, version, reason, attempts FROM track_facet_status WHERE track_id = ? AND facet = ?')
    .get(id, facet) as Row | undefined;
const trackCols = (id: string) =>
  sql().prepare('SELECT analyze_fail_count, analyze_error FROM tracks WHERE id = ?').get(id) as
    { analyze_fail_count: number | null; analyze_error: string | null };
const track = (id: string) => {
  db.upsertTrackMeta(id, { title: `T ${id}`, artist: 'A', album: 'B', duration: 340 } as never);
  db.upsertTrackAnalysis(id, {
    bpm: 62, musicalKey: 'C', loudnessLufs: -9, beats: [500, 1467], bars: [500], tailSilenceMs: 0,
    outro: { startMs: 300_000, ending: 'cold' } as never, source: 'full',
  } as never);
};
const grid = (id: string, over: Record<string, unknown> = {}) =>
  db.writeGridResult(id, { grid: analyzer.parseGridAnswer({ ...GOOD_GRID, ...over })! });
// A track with a grid whose bars are trusted (grid-policy.ts gridDecision).
const barred = (id: string) => { track(id); grid(id); };
const answer = (over: Record<string, unknown> = {}) => analyzer.parseStructureAnswer({ ...GOOD_STRUCTURE, ...over })!;
const gridAt = (id: string) => db.getGrid(id)!.measuredAt;
const allFacetRows = () =>
  sql().prepare('SELECT track_id, facet, status, version, reason, attempts FROM track_facet_status ORDER BY track_id, facet').all() as Array<{ track_id: string; facet: string }>;

test('the facet table re-derives to the same rows when no track has a grid', () => {
  for (const id of ['r1', 'r2']) track(id);
  db.recordAnalysisFailure('r2', 'not audio');
  const before = allFacetRows();
  db.resyncAllFacets(sql());
  assert.deepEqual(allFacetRows(), before);
  assert.equal(before.filter((r) => r.facet === 'structure').length, 0);
  assert.ok(!db.facetNeedsIds('structure').includes('r1'), 'no grid: not due');
});

test('bars not trusted settle as no-bars; trusted bars make the track due', () => {
  track('b1');
  grid('b1', { downbeat_agreement: 0.5 });
  assert.deepEqual(facetRow('b1'), { status: 'unmeasurable', version: db.STRUCTURE_FACET_VERSION, reason: 'no-bars', attempts: 0 });
  assert.ok(!db.facetNeedsIds('structure').includes('b1'));
  // The grid re-measured with agreeing downbeats: no row, due.
  grid('b1');
  assert.equal(facetRow('b1'), undefined);
  assert.ok(db.facetNeedsIds('structure').includes('b1'));
  // A grid that is no grid at all (no steady pulse) has no bars either.
  track('b2');
  db.writeGridResult('b2', { unmeasurable: 'no-beat', version: 1 });
  assert.equal(facetRow('b2')?.reason, 'no-bars');
  // The bars rule is the grid's own (gridDecision().bars): a held BPM holds them.
  track('b3');
  grid('b3', { coverage: 0.5 });
  assert.equal(facetRow('b3')?.reason, 'no-bars');
  // Reopened by the whole-table re-derive the same way.
  sql().prepare(`DELETE FROM track_facet_status WHERE facet = 'structure'`).run();
  db.resyncAllFacets(sql());
  assert.equal(facetRow('b2')?.reason, 'no-bars');
  assert.equal(facetRow('b1'), undefined);
});

test('a half-bar grid has trusted bars: due, not no-bars', () => {
  // Body split between beat 1 and beat 3 (agreement 0.53), nearly every
  // downbeat on that pair: grid-policy.ts trusts the bars, whichever rule
  // placed the bar line (the drop, or the majority without a clear one).
  const rescued = { downbeat_agreement: 0.53, downbeat_halfbar: 0.98, downbeat_drop_db: 14.2, downbeat_phase: 'drop' };
  track('h1');
  grid('h1', rescued);
  const g = db.getGrid('h1')!;
  assert.deepEqual([g.downbeatHalfbar, g.downbeatDropDb, g.downbeatPhase], [0.98, 14.2, 'drop']);
  assert.equal(gridDecision(g).bars, true);
  assert.ok(db.structureGridOf(g));
  assert.equal(facetRow('h1'), undefined, 'no no-bars row');
  assert.ok(db.facetNeedsIds('structure').includes('h1'));
  track('h3');
  grid('h3', { ...rescued, downbeat_drop_db: null, downbeat_phase: 'majority' });
  assert.equal(facetRow('h3'), undefined, 'no clear drop: the majority, still trusted');
  // A half-bar share under 0.9: still no bars.
  track('h2');
  grid('h2', { ...rescued, downbeat_halfbar: 0.8 });
  assert.equal(facetRow('h2')?.reason, 'no-bars');
  // The whole-table re-derive reads the grid through its own SQL JSON: the
  // same verdicts.
  sql().prepare(`DELETE FROM track_facet_status WHERE facet = 'structure'`).run();
  db.resyncAllFacets(sql());
  assert.equal(facetRow('h1'), undefined);
  assert.equal(facetRow('h3'), undefined);
  assert.equal(facetRow('h2')?.reason, 'no-bars');
  // A grid that loses the share (re-measured by an older worker) loses its bars.
  grid('h1', { downbeat_agreement: 0.53 });
  assert.equal(facetRow('h1')?.reason, 'no-bars');
});

test('parseStructureAnswer is strict', () => {
  const ok = answer();
  assert.ok(ok);
  assert.equal(ok.version, 1);
  assert.equal(ok.bars.kick.length, N);
  assert.deepEqual(ok.bars.runs, [[480, 1_935_484, N]]);
  assert.equal(ok.decodedMs, 340_000);
  const bad = (over: Record<string, unknown>) => analyzer.parseStructureAnswer({ ...GOOD_STRUCTURE, ...over });
  assert.equal(bad({ kick: GOOD_STRUCTURE.kick.slice(1) }), null, 'arrays of unequal length');
  assert.equal(bad({ runs: [[480, 1_935_484, N - 1]] }), null, 'runs not adding up to the bars');
  assert.equal(bad({ runs: [[480, 0, N]] }), null, 'no bar length');
  assert.equal(bad({ mid: [...GOOD_STRUCTURE.mid.slice(1), 'x'] }), null, 'not a number');
  assert.equal(bad({ kicks: [...GOOD_STRUCTURE.kicks.slice(1), 9] }), null, 'more kicks than beats in a bar');
  assert.equal(bad({ structure_version: undefined }), null, 'no version');
  assert.equal(bad({ level: undefined }), null, 'an array missing');
  assert.equal(bad({ runs: [], kick: [], kicks: [], bass: [], mid: [], high: [], level: [], melody: [] }), null, 'no bars');
  assert.equal(analyzer.parseStructureAnswer(null), null);
});

test('a structure write leaves the track\'s analysis failure history alone', () => {
  barred('s1');
  db.recordAnalysisFailure('s1', 'tail: placed window not reached');
  const before = trackCols('s1');
  db.writeStructureResult('s1', { structure: answer() }, gridAt('s1'));
  assert.deepEqual(trackCols('s1'), before, 'the failure count untouched');
  const s = db.getStructure('s1');
  assert.equal(s?.status, 'ok');
  assert.equal(s?.gridAt, gridAt('s1'));
  assert.equal(s?.bars?.kick.length, N);
  assert.deepEqual(facetRow('s1'), { status: 'ok', version: db.STRUCTURE_FACET_VERSION, reason: null, attempts: 0 });
  assert.ok(!db.facetNeedsIds('structure').includes('s1'));
  // The stored arrays are compact: no object per bar.
  const json = (sql().prepare(`SELECT bars_json FROM track_structure WHERE track_id = 's1'`).get() as { bars_json: string }).bars_json;
  assert.ok(!json.includes('{"'.repeat(2)) && json.length < 1000, json);
});

test('a structure failure is its own: the track\'s count stays, a measured row stays', () => {
  barred('s2');
  db.writeStructureResult('s2', { failed: 'ffmpeg failed: http://music.example/…' }, gridAt('s2'));
  assert.deepEqual(facetRow('s2'), { status: 'failed', version: 1, reason: 'ffmpeg failed: http://music.example/…', attempts: 1 });
  assert.equal(trackCols('s2').analyze_fail_count, null, 'no analysis failure');
  assert.equal(facetRow('s2', 'clap'), undefined, 'no failure fanned out onto other facets');
  db.writeStructureResult('s2', { failed: 'again' }, gridAt('s2'));
  assert.equal(facetRow('s2')?.attempts, 2);
  for (let i = 0; i < 2; i++) db.writeStructureResult('s2', { failed: 'again' }, gridAt('s2'));
  assert.ok(!db.facetNeedsIds('structure').includes('s2'), 'out of attempts');
  db.writeStructureResult('s2', { structure: answer() }, gridAt('s2'));
  db.writeStructureResult('s2', { failed: 'timeout' }, gridAt('s2'));
  const row = facetRow('s2')!;
  assert.equal(row.status, 'ok', 'the measured structure stays');
  assert.equal(row.attempts, 1);
  assert.equal(db.getStructure('s2')?.bars?.kick.length, N);
});

test('a regular analysis failure never creates a structure row', () => {
  barred('s3');
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('s3', 'not audio');
  assert.equal(facetRow('s3'), undefined);
  assert.ok(facetRow('s3', 'clap')?.status === 'failed', 'the regular fan-out still applies to the other facets');
  assert.ok(db.facetNeedsIds('structure').includes('s3'), 'its own attempts decide, not the track\'s');
});

test('an unmeasurable structure is settled, and no "Needs you" item', () => {
  barred('s4');
  const before = overview.computeOverview().attention;
  db.writeStructureResult('s4', { unmeasurable: 'too-long', version: 1 }, gridAt('s4'));
  assert.deepEqual(facetRow('s4'), { status: 'unmeasurable', version: 1, reason: 'too-long', attempts: 0 });
  assert.ok(!db.facetNeedsIds('structure').includes('s4'));
  const now = overview.computeOverview().attention;
  assert.equal(now.unmeasurable, before.unmeasurable);
  assert.equal(now.remeasure, before.remeasure);
  assert.ok(!overview.exportAttentionCsv().includes('structure'), 'not in the CSV either');
});

test('a re-measured grid makes the structure outdated; losing the bars settles it', async () => {
  barred('o1');
  db.writeStructureResult('o1', { structure: answer() }, gridAt('o1'));
  assert.equal(facetRow('o1')?.version, 1);
  await new Promise((r) => setTimeout(r, 5)); // a later measured_at
  grid('o1', { bpm: 125 });
  assert.deepEqual(facetRow('o1'), { status: 'ok', version: db.STRUCTURE_FACET_VERSION - 1, reason: 'grid-changed', attempts: 0 });
  assert.ok(db.facetNeedsIds('structure').includes('o1'));
  assert.ok(db.getStructure('o1')?.bars, 'the old arrays stay until re-measured');
  // Re-derived the same way.
  db.resyncAllFacets(sql());
  assert.equal(facetRow('o1')?.reason, 'grid-changed');
  db.writeStructureResult('o1', { structure: answer() }, gridAt('o1'));
  assert.deepEqual(facetRow('o1'), { status: 'ok', version: 1, reason: null, attempts: 0 });
  await new Promise((r) => setTimeout(r, 5));
  grid('o1', { downbeat_agreement: 0.4 });
  assert.equal(facetRow('o1')?.reason, 'no-bars');
  assert.ok(!db.facetNeedsIds('structure').includes('o1'));
});

test('a replaced file and a pruned track drop the structure; an ID rotation moves it', () => {
  barred('l1');
  db.writeStructureResult('l1', { structure: answer() }, gridAt('l1'));
  db.clearTrackAudio('l1');
  assert.equal(db.getStructure('l1'), null);
  assert.equal(facetRow('l1'), undefined);

  barred('l2');
  db.writeStructureResult('l2', { structure: answer() }, gridAt('l2'));
  const live = new Set((sql().prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map((r) => r.id));
  live.delete('l2');
  db.pruneMissingTracks(live);
  assert.equal((sql().prepare("SELECT COUNT(*) AS n FROM track_structure WHERE track_id = 'l2'").get() as { n: number }).n, 0);

  barred('l3');
  barred('l4');
  db.writeStructureResult('l3', { structure: answer() }, gridAt('l3'));
  db.writeStructureResult('l4', { structure: answer({ melody: Array(N).fill(1) }) }, gridAt('l4'));
  db.moveStructureRow(sql(), 'l3', 'l5');
  assert.equal(db.getStructure('l5')?.bars?.melody[0], 6.5, 'moved');
  assert.equal(db.getStructure('l3'), null);
  db.writeStructureResult('l3', { structure: answer() }, gridAt('l3'));
  db.moveStructureRow(sql(), 'l3', 'l4');
  assert.equal(db.getStructure('l4')?.bars?.melody[0], 1, 'the new id\'s own row wins');
  assert.equal(db.getStructure('l3'), null);

  // Orphans go with the whole-table re-derive.
  sql().prepare(`INSERT INTO track_structure (track_id, status, version, attempts, measured_at) VALUES ('ghost', 'ok', 1, 0, 'x')`).run();
  db.resyncAllFacets(sql());
  assert.equal(db.getStructure('ghost'), null);
});

test('the planner plans structure only on a positive capability; the model lane never does', () => {
  barred('p1');
  track('p2'); // no grid
  const plan = (structure: boolean | null | undefined, ids = ['p1']) => P.planAcoustics({
    ids, facets: ['structure'], where: { kind: 'needs' }, state: db.loadFacetState(P.planStateFacets(['structure'])),
    capabilities: { clap: null, demucs: null, tailVocal: null, structure },
  });
  for (const cap of [null, undefined, false]) {
    const p = plan(cap);
    assert.equal(p.items.length, 0, `capability ${cap}`);
    assert.equal(p.byFacet[0].skipped['no-structure'], 1);
  }
  assert.deepEqual(plan(true).items.map((i) => i.facets), [['structure']]);
  const noGrid = plan(true, ['p2']);
  assert.equal(noGrid.items.length, 0);
  assert.equal(noGrid.byFacet[0].skipped['no-grid'], 1, 'a track with no grid is skipped, not due');
  assert.ok(!R.regularRunFacets({ clap: true, vocal: true, stems: true } as never).includes('structure' as never));
  assert.ok(P.parseFacets('structure').includes('structure'));
  assert.ok(P.planStateFacets(['structure']).includes('grid'), 'the planner reads the grid rows too');
  assert.ok(P.formatPlan(plan(true)).some((l) => l.includes('structure')));
});

test('--where needs agrees with facetNeedsIds for structure', () => {
  const ids = db.allTrackIdsOrdered();
  const p = P.planAcoustics({
    ids, facets: ['structure'], where: { kind: 'needs' }, state: db.loadFacetState(P.planStateFacets(['structure'])),
    capabilities: { clap: null, demucs: null, tailVocal: null, structure: true },
  });
  assert.deepEqual(p.items.map((i) => i.id), db.facetNeedsIds('structure'));
  assert.equal(db.facetCounts().find((c) => c.facet === 'structure')?.needs, db.facetNeedsIds('structure').length);
});

test('a structure-only plan streams by URL, carries the grid and writes the row', async () => {
  barred('run1');
  const before = trackCols('run1');
  await analyzer.isAvailable();
  assert.equal(analyzer.structureAvailable(), true);
  structureAnswer = { status: 'ok', data: GOOD_STRUCTURE };
  requests.length = 0;
  streamHits = 0;
  const plan = P.planAcoustics({
    ids: ['run1'], facets: ['structure'], where: { kind: 'needs' }, state: db.loadFacetState(P.planStateFacets(['structure'])),
    capabilities: { clap: false, demucs: false, tailVocal: false, structure: analyzer.structureAvailable() },
  });
  assert.equal(plan.items.length, 1);
  await runAnalysisPass({ plan });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].facets, ['structure']);
  assert.ok(typeof requests[0].url === 'string' && !('path' in requests[0]), 'by url, no staged copy');
  assert.equal(streamHits, 0, 'no capped download');
  assert.deepEqual(requests[0].structure_grid, {
    beats_per_bar: 4, decoded_ms: 340_000,
    segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  });
  assert.equal(db.getStructure('run1')?.status, 'ok');
  assert.equal(db.getStructure('run1')?.gridAt, gridAt('run1'));
  assert.deepEqual(trackCols('run1'), before);
  assert.ok(!db.facetNeedsIds('structure').includes('run1'), 'a second run asks for nothing');
});

test('a track whose grid lost its bars after planning is not sent', async () => {
  track('run2');
  grid('run2', { downbeat_agreement: 0.3 });
  requests.length = 0;
  await runAnalysisPass({ plan: { where: { kind: 'needs' }, facets: ['structure'], inScope: 1, items: [{ id: 'run2', facets: ['structure'], request: P.requestFor([]) }], byFacet: [], rideAlong: [], warnings: [] } });
  assert.equal(requests.length, 0);
  assert.equal(facetRow('run2')?.reason, 'no-bars');
});

test('a structure that fails alone is stamped on its row, never on the track', async () => {
  for (const id of ['f1', 'f2', 'f3']) barred(id);
  const item = (id: string) => ({ id, facets: ['structure'] as Array<'structure'>, request: P.requestFor([]) });
  const planOf = (ids: string[]) => ({
    where: { kind: 'needs' as const }, facets: ['structure' as const], inScope: ids.length,
    items: ids.map(item), byFacet: [], rideAlong: [], warnings: [],
  });
  structureAnswer = { status: 'failed', reason: 'decode failed' };
  await runAnalysisPass({ plan: planOf(['f1', 'f2']) });
  // Held until a success proves the pass healthy (the systemic guard's rule).
  structureAnswer = { status: 'ok', data: GOOD_STRUCTURE };
  await runAnalysisPass({ plan: planOf(['f3']) });
  for (const id of ['f1', 'f2']) {
    assert.equal(trackCols(id).analyze_fail_count, null, `${id}: no analysis failure`);
    assert.equal(trackCols(id).analyze_error, null);
    const s = db.getStructure(id);
    assert.deepEqual([s?.status, s?.attempts, s?.reason], ['failed', 1, 'decode failed']);
  }
  assert.equal(db.getStructure('f3')?.status, 'ok');
  // A malformed answer is a failed attempt, never a partial row.
  barred('f4');
  structureAnswer = { status: 'ok', data: { ...GOOD_STRUCTURE, kick: [1] } };
  await runAnalysisPass({ plan: planOf(['f4', 'f3']) });
  assert.equal(db.getStructure('f4')?.status, 'failed');
});

test('an unavailable structure (older analyzer) writes nothing', async () => {
  barred('u1');
  structureAnswer = { status: 'unavailable', reason: 'numpy missing' };
  await runAnalysisPass({ plan: { where: { kind: 'needs' }, facets: ['structure'], inScope: 1, items: [{ id: 'u1', facets: ['structure'], request: P.requestFor([]) }], byFacet: [], rideAlong: [], warnings: [] } });
  assert.equal(db.getStructure('u1'), null);
  assert.equal(facetRow('u1'), undefined);
});

test('the report reads the points off the stored arrays', () => {
  const rows = report.structureReport(['s1', 'b2', 'p2', 'nope']);
  const s1 = rows.find((r) => r.id === 's1')!;
  assert.deepEqual(
    [s1.title, s1.status, s1.bars, s1.fullSectionStart, s1.firstHardKick, s1.lastHardKick, s1.introBars, s1.outroBars],
    ['T s1', 'ok', N, 5, 5, N, 4, 0],
  );
  assert.equal(s1.firstHardKickMs, 480 + 4 * 1935.484);
  assert.equal(rows.find((r) => r.id === 'b2')?.status, 'unmeasurable');
  assert.equal(rows.find((r) => r.id === 'b2')?.reason, 'no-bars');
  assert.equal(rows.find((r) => r.id === 'p2')?.status, 'missing');
  assert.equal(rows.find((r) => r.id === 'nope'), undefined, 'unknown ids are left out');
  const lines = report.formatStructureReport(rows);
  assert.ok(lines.some((l) => l.includes('s1') && l.includes('T s1')));
  // Every measured row when no ids are given.
  assert.ok(report.structureReport().some((r) => r.id === 'run1'));
});
