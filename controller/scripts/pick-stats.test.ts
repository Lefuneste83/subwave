// pickStats() (#1723): the narrow, long-cached library counts a live pick reads,
// in place of the dashboard's stats() and its ~9 full-table scans.
//
// The contracts pinned here:
//   - every field equals what stats() says for the same library, so switching
//     the pick path to pickStats() changes no decision (recency windows, show
//     locks, tool registration);
//   - a warm call costs nothing, and the cache only expires on its TTL or on
//     invalidateStats() (a handle swap);
//   - idsByEnergy() returns exactly the ids songsByEnergy() would, in order,
//     without mapping rows.
//
// Real better-sqlite3 DB in a temp STATE_DIR. Run: `tsx scripts/pick-stats.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-pick-stats-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const moods = ['calm', 'dark', 'warm'];
const energies = ['low', 'medium', 'high', null] as const;
for (let i = 0; i < 300; i++) {
  const id = `t${String(i).padStart(3, '0')}`;
  db.upsertTrackMeta(id, { title: `Song ${i}`, artist: i % 7 === 0 ? ` Artist ${i % 40} ` : `artist ${i % 40}`, album: 'A', duration: 200 });
  // A third untagged, so total ≠ mirrorTotal and distinctArtists counts tagged only.
  if (i % 3 !== 0) {
    const e = energies[i % 4];
    db.upsertTrackTags(id, { moods: [moods[i % 3]], energy: e ?? undefined, source: 'llm' } as never);
  }
  if (i % 5 === 0) db.upsertTrackAudioVector(id, new Float32Array(512).fill(0.1));
  if (i % 4 === 0) db.upsertTrackVector(id, [1, 2, 3, 4, 5, 6, 7, 8], null);
}
await library.load();

test('every pickStats field agrees with the dashboard stats()', () => {
  db.invalidateStats();
  const full = db.stats();
  db.invalidateStats();
  const p = db.pickStats();
  assert.deepEqual(p, {
    total: full.total,
    mirrorTotal: full.mirrorTotal,
    distinctArtists: full.distinctArtists,
    withEmbedding: full.withEmbedding,
    withAudioEmbedding: full.withAudioEmbedding,
    hasMoodCoverage: Object.keys(full.byMood).length > 0,
    hasEnergyCoverage: Object.keys(full.byEnergy).length > 0,
  });
  assert.equal(p.mirrorTotal, 300);
  assert.ok(p.total > 0 && p.total < 300, 'untagged rows are excluded from total');
});

test('an empty library reports no coverage', () => {
  // Empty the tracks inside a savepoint and roll back, so later tests keep the fixture.
  const d = db.requireDb();
  d.exec('SAVEPOINT empty');
  d.exec('DELETE FROM tracks');
  db.invalidateStats();
  const p = db.pickStats();
  assert.equal(p.mirrorTotal, 0);
  assert.equal(p.hasMoodCoverage, false);
  assert.equal(p.hasEnergyCoverage, false);
  d.exec('ROLLBACK TO empty');
  d.exec('RELEASE empty');
  db.invalidateStats();
});

test('a warm call is free and stays cached until invalidated', () => {
  db.invalidateStats();
  const first = db.pickStats();
  db.upsertTrackMeta('late', { title: 'Late', artist: 'New', album: 'B', duration: 200 });
  const t0 = performance.now();
  const second = db.pickStats();
  const warmMs = performance.now() - t0;
  assert.deepEqual(second, first, 'within the TTL the cached counts are served');
  assert.ok(warmMs < 5, `warm call took ${warmMs.toFixed(2)} ms`);
  db.invalidateStats();
  assert.equal(db.pickStats().mirrorTotal, first.mirrorTotal + 1);
});

test('idsByEnergy matches songsByEnergy, in order', () => {
  for (const e of ['low', 'medium', 'high'] as const) {
    assert.deepEqual(library.idsByEnergy(e), library.songsByEnergy(e).map((s: any) => s.id), e);
  }
  assert.deepEqual(library.idsByEnergy('loud'), []);
  assert.equal(library.isBlockedId('t001'), false);
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
