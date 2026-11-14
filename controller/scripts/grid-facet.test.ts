// The whole-track beat grid on the controller side (library-db/grid.ts, the
// `grid` facet): storage, its own failure history, the planner gate, and the
// pass writing a grid-only plan. Real better-sqlite3 DB in a temp STATE_DIR;
// the analyzer and Navidrome are a local HTTP stub.
//
// Pinned here (an upgrade changes nothing a station plays, and the grid is
// opt-in):
//   - the analyzer's answer is parsed strictly: a malformed one is a failed
//     attempt, never a partial grid;
//   - a grid write never touches the track's analysis failure history, and a
//     grid failure never counts against it (nor the other way round): the
//     grid's attempts are its own;
//   - an ok grid survives a later failed attempt;
//   - a regular analysis failure never creates a grid row (no failure
//     fan-out onto an opt-in facet);
//   - an unmeasurable grid (no steady pulse) is settled, never due again and
//     never a fault of the file;
//   - a replaced file and a pruned track drop the grid; an ID rotation moves
//     it (the new id's own row wins);
//   - the planner plans `grid` only on a positive capability (unknown = not
//     planned, unlike CLAP), and a regular run never plans it;
//   - a grid-only plan streams by URL (no capped download), writes the grid
//     and leaves bpm/beats/bars as they were; a grid that fails alone is
//     stamped on the grid row, never on analyze_fail_count;
//   - adding the facet re-derives the facet table to the same rows for every
//     track without a grid.
// Run: `npm test -- grid-facet`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const requests: Array<Record<string, unknown>> = [];
const gridCapable: boolean | undefined = true;
let gridAnswer: Record<string, unknown> = {};
let streamHits = 0;
const GOOD_GRID = {
  grid_version: 1, engine: 'beat_this', model: 'final0', bpm: 124.0, beats_per_bar: 4,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  coverage: 0.98, residual_ms: 5.2, downbeat_agreement: 0.84, main_share: 0.99,
  beats_detected: 712, decoded_ms: 340_000,
};

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_capable: true,
      ...(gridCapable === undefined ? {} : { analyze_grid_capable: gridCapable }),
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
      for (const f of r.facets ?? []) facets[f] = f === 'grid' ? gridAnswer : { status: 'ok', data: {} };
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
const stateDir = createTempDir(join(tmpdir(), 'subwave-grid-'));
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
const analyzer = await import('../src/music/analyzer.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const sql = () => db.requireDb();

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
  await removeTempDir(stateDir);
});

const facetRow = (id: string, facet: string) =>
  sql().prepare('SELECT status, version, reason, attempts FROM track_facet_status WHERE track_id = ? AND facet = ?')
    .get(id, facet) as { status: string; version: number; reason: string | null; attempts: number } | undefined;
const trackCols = (id: string) =>
  sql().prepare('SELECT bpm, beats_json, bars_json, analyze_fail_count, analyze_error FROM tracks WHERE id = ?').get(id) as
    { bpm: number | null; beats_json: string | null; bars_json: string | null; analyze_fail_count: number | null; analyze_error: string | null };
const track = (id: string) => {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
  db.upsertTrackAnalysis(id, {
    bpm: 62, musicalKey: 'C', loudnessLufs: -9, beats: [500, 1467], bars: [500], tailSilenceMs: 0,
    outro: { startMs: 300_000, ending: 'cold' } as never, source: 'full',
  } as never);
};
const allFacetRows = () =>
  sql().prepare('SELECT track_id, facet, status, version, reason, attempts FROM track_facet_status ORDER BY track_id, facet').all() as Array<{ facet: string }>;

test('the facet table re-derives to the same rows when no track has a grid', () => {
  for (const id of ['r1', 'r2']) track(id);
  db.recordAnalysisFailure('r2', 'not audio');
  const before = allFacetRows();
  db.resyncAllFacets(sql());
  assert.deepEqual(allFacetRows(), before);
  assert.equal(before.filter((r) => r.facet === 'grid').length, 0);
});

test('parseGridAnswer is strict', () => {
  const ok = analyzer.parseGridAnswer(GOOD_GRID);
  assert.ok(ok);
  assert.equal(ok.bpm, 124);
  assert.equal(ok.beatsPerBar, 4);
  assert.deepEqual(ok.segments, [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }]);
  assert.equal(analyzer.parseGridAnswer({ ...GOOD_GRID, segments: [] }), null, 'no segment');
  assert.equal(analyzer.parseGridAnswer({ ...GOOD_GRID, bpm: 0 }), null, 'no tempo');
  assert.equal(analyzer.parseGridAnswer({ ...GOOD_GRID, segments: [{ anchorMs: 0, periodUs: -1, beats: 9 }] }), null, 'bad period');
  assert.equal(analyzer.parseGridAnswer({ ...GOOD_GRID, segments: [{ anchorMs: 0, periodUs: 500000, beats: 9, downbeatMs: 'x' }] }), null);
  assert.equal(analyzer.parseGridAnswer({ ...GOOD_GRID, beats_per_bar: 11 })?.beatsPerBar, null, 'an odd metre past 7 is unknown');
  assert.equal(analyzer.parseGridAnswer(null), null);
});

test('a grid write leaves the track\'s analysis failure history alone', () => {
  track('g1');
  db.recordAnalysisFailure('g1', 'tail: placed window not reached');
  const before = trackCols('g1');
  db.writeGridResult('g1', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  const after = trackCols('g1');
  assert.deepEqual([after.analyze_fail_count, after.analyze_error], [before.analyze_fail_count, before.analyze_error],
    'the failure count untouched');
  // The grid passes the gate (grid-apply.test.ts pins the write itself).
  assert.equal(after.bpm, 124);
  const g = db.getGrid('g1');
  assert.equal(g?.status, 'ok');
  assert.equal(g?.bpm, 124);
  assert.equal(g?.segments.length, 1);
  assert.deepEqual(facetRow('g1', 'grid'), { status: 'ok', version: db.GRID_FACET_VERSION, reason: null, attempts: 0 });
});

test('a grid failure is the grid\'s own: the track\'s count stays, a measured grid stays', () => {
  track('g2');
  db.writeGridResult('g2', { failed: 'Beat This! out of memory' });
  assert.deepEqual(facetRow('g2', 'grid'), { status: 'failed', version: 1, reason: 'Beat This! out of memory', attempts: 1 });
  assert.equal(trackCols('g2').analyze_fail_count, null, 'no analysis failure');
  assert.equal(facetRow('g2', 'clap'), undefined, 'no failure fanned out onto other facets');
  db.writeGridResult('g2', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  db.writeGridResult('g2', { failed: 'timeout' });
  const row = facetRow('g2', 'grid')!;
  assert.equal(row.status, 'ok', 'the measured grid stays');
  assert.equal(row.attempts, 1);
  assert.equal(db.getGrid('g2')?.bpm, 124);
});

test('a regular analysis failure never creates a grid row', () => {
  track('g3');
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('g3', 'not audio');
  assert.equal(facetRow('g3', 'grid'), undefined);
  assert.ok(facetRow('g3', 'clap')?.status === 'failed', 'the regular fan-out still applies to the other facets');
});

test('an unmeasurable grid is settled: no longer due, and no file problem', () => {
  track('g4');
  db.writeGridResult('g4', { unmeasurable: 'no-beat', version: 1 });
  assert.deepEqual(facetRow('g4', 'grid'), { status: 'unmeasurable', version: 1, reason: 'no-beat', attempts: 0 });
  assert.ok(!db.facetNeedsIds('grid').includes('g4'), 'a track with no steady pulse is not planned again');
  assert.equal(trackCols('g4').analyze_fail_count ?? 0, 0, 'nothing counts against the file');
});

test('a replaced file and a pruned track drop the grid; an ID rotation moves it', () => {
  track('g5');
  db.writeGridResult('g5', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  db.clearTrackAudio('g5');
  assert.equal(db.getGrid('g5'), null);
  assert.equal(facetRow('g5', 'grid'), undefined);

  track('g6');
  db.writeGridResult('g6', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  const live = new Set((sql().prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map((r) => r.id));
  live.delete('g6');
  db.pruneMissingTracks(live);
  assert.equal((sql().prepare("SELECT COUNT(*) AS n FROM track_grid WHERE track_id = 'g6'").get() as { n: number }).n, 0);

  track('g7');
  track('g8');
  db.writeGridResult('g7', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  db.writeGridResult('g8', { grid: analyzer.parseGridAnswer({ ...GOOD_GRID, bpm: 100 })! });
  db.moveGridRow(sql(), 'g7', 'g9');
  assert.equal(db.getGrid('g9')?.bpm, 124, 'moved');
  assert.equal(db.getGrid('g7'), null);
  db.writeGridResult('g7', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  db.moveGridRow(sql(), 'g7', 'g8');
  assert.equal(db.getGrid('g8')?.bpm, 100, 'the new id\'s own row wins');
  assert.equal(db.getGrid('g7'), null);
});

test('the planner plans grid only on a positive capability; a regular run never does', () => {
  track('p1');
  const plan = (grid: boolean | null | undefined) => P.planAcoustics({
    ids: ['p1'], facets: ['grid'], where: { kind: 'needs' }, state: db.loadFacetState(['grid']),
    capabilities: { clap: null, demucs: null, tailVocal: null, grid },
  });
  for (const cap of [null, undefined, false]) {
    const p = plan(cap);
    assert.equal(p.items.length, 0, `capability ${cap}`);
    assert.equal(p.byFacet[0].skipped['no-grid'], 1);
  }
  assert.deepEqual(plan(true).items.map((i) => i.facets), [['grid']]);
  assert.ok(P.parseFacets('grid').includes('grid'));
});

test('a regular pass (no plan) never asks for the grid', async () => {
  track('reg1');
  await analyzer.isAvailable();
  requests.length = 0;
  await runAnalysisPass({});
  assert.ok(requests.every((r) => !((r.facets as string[] | undefined) ?? []).includes('grid')), JSON.stringify(requests));
});

test('a grid-only plan streams by URL and writes the grid', async () => {
  track('run1');
  const before = trackCols('run1');
  await analyzer.isAvailable();
  gridAnswer = { status: 'ok', data: GOOD_GRID };
  requests.length = 0;
  streamHits = 0;
  const plan = P.planAcoustics({
    ids: ['run1'], facets: ['grid'], where: { kind: 'needs' }, state: db.loadFacetState(['grid']),
    capabilities: { clap: false, demucs: false, tailVocal: false, grid: analyzer.gridAvailable() },
  });
  assert.equal(plan.items.length, 1);
  await runAnalysisPass({ plan });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].facets, ['grid']);
  assert.ok(typeof requests[0].url === 'string' && !('path' in requests[0]), 'by url, no staged copy');
  assert.equal(streamHits, 0, 'no capped download');
  assert.equal(db.getGrid('run1')?.bpm, 124);
  assert.equal(trackCols('run1').bpm, 124, 'applied over the head (grid-apply.test.ts)');
  assert.deepEqual([trackCols('run1').analyze_fail_count, trackCols('run1').analyze_error], [before.analyze_fail_count, before.analyze_error]);
});

test('a grid that fails alone is stamped on the grid row, never on the track', async () => {
  for (const id of ['f1', 'f2', 'f3']) track(id);
  const item = (id: string) => ({ id, facets: ['grid'] as Array<'grid'>, request: P.requestFor([]) });
  const planOf = (ids: string[]) => ({
    where: { kind: 'needs' as const }, facets: ['grid' as const], inScope: ids.length,
    items: ids.map(item), byFacet: [], rideAlong: [], warnings: [],
  });
  gridAnswer = { status: 'failed', reason: 'CUDA out of memory' };
  await runAnalysisPass({ plan: planOf(['f1', 'f2']) });
  // Held until a success proves the pass healthy (the systemic guard's rule).
  gridAnswer = { status: 'ok', data: GOOD_GRID };
  await runAnalysisPass({ plan: planOf(['f3']) });
  for (const id of ['f1', 'f2']) {
    assert.equal(trackCols(id).analyze_fail_count, null, `${id}: no analysis failure`);
    assert.equal(trackCols(id).analyze_error, null);
    assert.deepEqual([db.getGrid(id)?.status, db.getGrid(id)?.attempts, db.getGrid(id)?.reason], ['failed', 1, 'CUDA out of memory']);
  }
  assert.equal(db.getGrid('f3')?.status, 'ok');
});

test('an unavailable grid (lean analyzer) writes nothing', async () => {
  track('u1');
  gridAnswer = { status: 'unavailable', reason: 'Beat This! not installed' };
  await runAnalysisPass({ plan: { where: { kind: 'needs' }, facets: ['grid'], inScope: 1, items: [{ id: 'u1', facets: ['grid'], request: P.requestFor([]) }], byFacet: [], rideAlong: [], warnings: [] } });
  assert.equal(db.getGrid('u1'), null);
  assert.equal(facetRow('u1', 'grid'), undefined);
  assert.equal(trackCols('u1').analyze_fail_count, null);
});
