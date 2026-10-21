// Fork-only: the whole-file facets first shipped as schema step 29, the number
// upstream then gave its library search keys (#1955). A fork station already
// at 29 skips upstream's step, so step 30 adds the search-key columns too and
// fills them like a fresh upgrade. This pins that catch-up on the shape a
// production database has: whole-file columns present, search keys absent.
// Run: npm test -- schema-fork-catchup
import { createTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-schema-catchup-'));

const db = await import('../src/music/library-db.js');
const { SEARCH_KEY_DDL } = await import('../src/music/library-db/search-keys.js');

const columns = () => new Set(
  (db.getDb()!.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(c => c.name),
);

test('a fork database at 29 without search keys gets them, filled, at 30', async () => {
  await db.open({ embeddingDim: 4 });
  db.upsertTrackMeta('acdc', { title: 'Thunderstruck', artist: 'AC/DC', album: 'The Razors Edge' });
  const d = db.getDb()!;
  // Wind the database back to what the fork's own step 29 left behind.
  d.exec('DROP TRIGGER IF EXISTS tracks_search_stale; DROP INDEX IF EXISTS tracks_search_stale_idx;');
  for (const c of [...SEARCH_KEY_DDL.columns]) {
    for (const ix of d.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tracks' AND sql LIKE ?`).pluck().all(`%${c}%`) as string[]) {
      d.exec(`DROP INDEX ${ix}`);
    }
    d.exec(`ALTER TABLE tracks DROP COLUMN ${c}`);
  }
  d.pragma('user_version = 29');
  assert.ok(columns().has('edge_lead_ms'), 'the whole-file columns are what step 29 left');
  assert.ok(!columns().has('search_fresh'));
  db.close();

  await db.open({ embeddingDim: 4 });
  assert.ok((db.getDb()!.pragma('user_version', { simple: true }) as number) >= 30);
  for (const c of SEARCH_KEY_DDL.columns) assert.ok(columns().has(c), `${c} added`);
  const row = db.getDb()!.prepare(`SELECT title_key, search_fresh FROM tracks WHERE id = 'acdc'`).get();
  assert.deepEqual(row, { title_key: 'thunderstruck', search_fresh: 1 }, 'filled on the upgrade, not on the first search');
  db.close();
});
