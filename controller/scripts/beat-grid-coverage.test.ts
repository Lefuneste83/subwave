// The Library tagging panel's beat grid and structure rows: what
// /library/coverage reports for the two opt-in facets a regular run measures
// while a show has Hot Mix on (library-coverage.ts).
//
// Pinned here:
//   - measured (ok) and due counts come from refresh() only: get() never
//     counts them, so a grid written after the count is not seen until the
//     next one, and before any count they read null ("not counted yet");
//   - the counts persist with the library count, so a restart serves them;
//   - `gridWanted` follows the Hot Mix rule (any show with Hot Mix on), and
//     the analyzer's capabilities ride along (null while unknown).
// Run: `npm test -- beat-grid-coverage`.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// An empty music server, so the Navidrome half of a count succeeds (the
// counts persist only beside a library count, like the vector figures).
const navi = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', albumList2: { album: [] } } }));
});
await new Promise<void>((r) => navi.listen(0, '127.0.0.1', () => r()));

const STATE = createTempDir(join(tmpdir(), 'subwave-beat-grid-coverage-'));
process.env.STATE_DIR = STATE;
process.env.NAVIDROME_URL = `http://127.0.0.1:${(navi.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_URL;
delete process.env.ANALYZE_PYTHON;

const db = await import('../src/music/library-db.js');
const analyzer = await import('../src/music/analyzer.js');
const settings = await import('../src/settings.js');
const coverage = await import('../src/music/library-coverage.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const GOOD_GRID = {
  grid_version: 1, engine: 'beat_this', model: 'final0', bpm: 124.0, beats_per_bar: 4,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  coverage: 0.98, residual_ms: 5.2, downbeat_agreement: 0.84, main_share: 0.99,
  beats_detected: 712, decoded_ms: 340_000,
};
const N = 20;
const GOOD_STRUCTURE = {
  structure_version: 1, runs: [[480, 1_935_484, N]],
  kick: Array(N).fill(0), kicks: Array(N).fill(4), bass: Array(N).fill(-2), mid: Array(N).fill(-1),
  high: Array(N).fill(-3), level: Array(N).fill(-1), melody: Array(N).fill(6.5), decoded_ms: 340_000,
};

const track = (id: string) => db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
const grid = (id: string) => db.writeGridResult(id, { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
const structure = (id: string) =>
  db.writeStructureResult(id, { structure: analyzer.parseStructureAnswer(GOOD_STRUCTURE)! }, db.getGrid(id)!.measuredAt);

before(async () => {
  await settings.load();
});

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((r) => navi.close(() => r()));
  await removeTempDir(STATE);
});

test('before any count the grid and structure figures read null, and Hot Mix off is not wanted', async () => {
  for (const id of ['t1', 't2', 't3']) track(id);
  grid('t1');
  const snap = await coverage.get();
  assert.equal(snap.gridMeasured, null);
  assert.equal(snap.structureMeasured, null);
  assert.equal(snap.gridDue, null);
  assert.equal(snap.structureDue, null);
  assert.equal(snap.beatGridCountedAt, null);
  assert.equal(snap.gridWanted, false);
  assert.equal(snap.gridAvailable, null, 'no analyzer: unknown');
  assert.equal(snap.structureAvailable, null);
});

test('refresh() counts measured and due grids and structures; get() never recounts', async () => {
  grid('t2');
  structure('t1');
  await coverage.refresh();
  const snap = await coverage.get();
  assert.equal(snap.gridMeasured, 2);
  assert.equal(snap.structureMeasured, 1);
  assert.equal(snap.gridDue, 1, 't3 has no grid');
  assert.equal(snap.structureDue, 1, 't2 has a grid with trusted bars and no structure; t3 has no grid, so is not due');
  assert.ok(snap.beatGridCountedAt);

  // A grid written after the count is not seen by the read path.
  grid('t3');
  const again = await coverage.get();
  assert.equal(again.gridMeasured, 2);
  assert.equal(again.gridDue, 1);
  await coverage.refresh();
  assert.equal((await coverage.get()).gridMeasured, 3);
});

test('the counts persist: a restarted controller serves them', async () => {
  const fresh = await import(`../src/music/library-coverage.js?boot=${Date.now()}`);
  const snap = await fresh.get();
  assert.equal(snap.gridMeasured, 3);
  assert.equal(snap.structureMeasured, 1);
});

test('gridWanted follows the Hot Mix rule', async () => {
  await settings.update({
    shows: [{ id: 's_mix', name: 'Night Set', personaId: settings.get().personas[0].id, hotMix: { enabled: true } }],
  } as never);
  assert.equal((await coverage.get()).gridWanted, true);
  await settings.update({ shows: [] } as never);
  assert.equal((await coverage.get()).gridWanted, false);
});
