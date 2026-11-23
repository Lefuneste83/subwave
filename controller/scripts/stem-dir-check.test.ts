// A pass looks up only its planned tracks in the stem cache's dir set, so a
// small plan checks each name instead of listing a root that holds a dir per
// cached track (stem-cache.ts cachedTrackIdsAmong).
//
// Pinned here:
//   - the answer is cachedTrackIdSet()'s for those ids, odd names included
//     (a file entry counts, dotted names, separators and empty ids never do);
//   - a plan up to STEM_DIR_CHECK_MAX lists nothing; a larger one lists once.
// Run: `npm test -- stem-dir-check`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-stem-dir-check-'));
process.env.STATE_DIR = dir;
const stemCache = await import('../src/music/stem-cache.js');
after(async () => { await removeTempDir(dir); });

const root = stemCache.stemsRoot();
mkdirSync(root, { recursive: true });
for (const d of ['a', 'b', 'with space', 'é']) mkdirSync(join(root, d));
writeFileSync(join(root, 'c'), 'not a dir');
writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
mkdirSync(join(root, '.quarantine'));

test('the planned ids get the listing\'s own answer, odd names included', async () => {
  const ids = ['a', 'c', 'x', 'with space', 'é', '.quarantine', stemCache.STEMS_MARKER, '..', '.', 'a/b', '', 'b'];
  const listed = await stemCache.cachedTrackIdSet();
  const expected = new Set(ids.filter((id) => listed.has(id)));
  const before = stemCache._cacheWalksForTests();
  assert.deepEqual([...(await stemCache.cachedTrackIdsAmong(ids))].sort(), [...expected].sort());
  assert.equal(stemCache._cacheWalksForTests(), before, 'a small plan never lists the root');
  assert.deepEqual([...expected].sort(), ['a', 'b', 'c', 'with space', 'é'].sort());
});

test('a plan larger than the per-name bound lists the root once', async () => {
  const ids = Array.from({ length: stemCache.STEM_DIR_CHECK_MAX + 1 }, (_, i) => (i === 0 ? 'a' : `none${i}`));
  const before = stemCache._cacheWalksForTests();
  assert.deepEqual([...(await stemCache.cachedTrackIdsAmong(ids))], ['a']);
  assert.equal(stemCache._cacheWalksForTests(), before + 1);
});
