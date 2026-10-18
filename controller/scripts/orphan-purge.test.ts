// B10 — orphan-stem purge, IO layer against a temp STATE_DIR (music/orphan-purge.ts).
// The decisions themselves are pinned in scripts/orphan-purge-pure.test.ts; this
// file drives real directories: move-to-quarantine, the aged delete, release
// back to the library, the in-flight grace, failure accounting, and the
// snapshot invalidation that keeps the usage report honest.
//
// stem-cache resolves its root from config at import time, so this file loads
// the modules ONCE against one temp STATE_DIR (matching scripts/stem-cache-sweep.test.ts)
// and gives every test its own directory names. Quarantine age is steered by
// passing a future `now` to the pass, not by racing mtimes.

import { createTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const DAY = 86400_000;

const stateDir = createTempDir('subwave-orphan-io-');
process.env.STATE_DIR = stateDir;
const cache = await import('../src/music/stem-cache.js');
const purge = await import('../src/music/orphan-purge.js');
const ROOT = cache.stemsRoot();
const QU = join(ROOT, '.orphan-quarantine');
mkdirSync(ROOT, { recursive: true });
// Production caches carry the marker; without it every empty fresh root reads
// as an unmounted share. The offline-but-quarantine-visible case has its own
// test below.
writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
const NOW_BASE = Date.now();

let seq = 0;
function seedStem(opts: { fresh?: boolean } = {}): string {
  const id = `track-${seq++}`;
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'window-drums.flac'), 'x'.repeat(1024));
  if (!opts.fresh) {
    // Two days behind `nowBase` below; passes use nowBase so it is not in-flight.
    const t = new Date(NOW_BASE - 2 * DAY);
    utimesSync(dir, t, t);
  }
  return id;
}

test('an orphan is moved into the quarantine, and it leaves the cache root', async () => {
  const gone = seedStem();
  const kept = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: [kept, '_sentinel'], confirm: true, now: NOW_BASE });
  assert.equal(rep.quarantined, 1);
  assert.ok(!existsSync(join(ROOT, gone)));
  assert.ok(existsSync(join(QU, gone)));
  assert.ok(existsSync(join(ROOT, kept)));
});

test('an unconfirmed pass is a dry run: the report counts, the disk does not change', async () => {
  const gone = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE });
  assert.equal(rep.dryRun, true);
  assert.ok(rep.quarantined >= 1);
  assert.ok(existsSync(join(ROOT, gone)), 'dry run must not move anything');
});

test('a quarantine past the grace period is deleted and its bytes counted', async () => {
  const oldOrphan = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  assert.ok(existsSync(join(QU, oldOrphan)));
  // 8 days later: past the 7-day grace.
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
  // The shared root carries quarantines from earlier tests, so assert "this one
  // is gone" plus at-least-one deleted, not an exact count.
  assert.ok(rep.deletedCount >= 1);
  assert.ok(rep.freedBytes >= 1024);
  assert.ok(!existsSync(join(QU, oldOrphan)));
});

test('a quarantine inside the grace period only ages', async () => {
  const fresh = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + DAY });
  assert.equal(rep.deletedCount, 0);
  assert.ok(rep.agingCount >= 1);
  assert.ok(existsSync(join(QU, fresh)));
});

test('a quarantined id that walked back into the library is released to its live slot', async () => {
  const revival = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const rep = await purge.runOrphanPurge({ knownIds: [revival, '_sentinel'], confirm: true, now: NOW_BASE + DAY });
  assert.ok(rep.released.includes(revival));
  assert.ok(existsSync(join(ROOT, revival)));
  assert.ok(!existsSync(join(QU, revival)));
});

test('directories written in the last hour are never quarantined', async () => {
  const midWrite = seedStem();
  // Pin the dir five minutes before a pass that runs at that same `now`:
  // in-flight by age, whatever the earlier tests' clock jumps left behind.
  const inFlightNow = NOW_BASE + 402 * DAY;
  { const { utimesSync: u } = await import('node:fs'); const t = new Date(inFlightNow - 300_000); u(join(ROOT, midWrite), t, t); }
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: inFlightNow });
  // Earlier tests leave aged dirs that legitimately quarantine in this pass;
  // what matters is that the fresh one is neither moved nor counted.
  assert.equal(rep.inFlight, 1);
  assert.ok(!rep.quarantinedNames.includes(midWrite));
  assert.ok(existsSync(join(ROOT, midWrite)));
});

test('an empty id set is refused, not trusted as an empty library', async () => {
  const aTrack = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: [], confirm: true, now: NOW_BASE });
  assert.equal(rep.refused, true);
  assert.equal(rep.quarantined, 0);
  assert.ok(existsSync(join(ROOT, aTrack)));
});

test('a quarantine that cannot be deleted is counted, never thrown', async () => {
  const stuck = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const q = join(QU, stuck);
  // The quarantine entry itself refuses deletion (root-squashed NFS: the dir
  // is read-only, so removing the file inside fails). readdir still works.
  chmodSync(q, 0o555);
  try {
    const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
    assert.equal(rep.failed, 1);
    assert.ok(existsSync(q));
  } finally {
    chmodSync(q, 0o755);
  }
});

test('the usage snapshot is invalidated when the purge moved anything', async () => {
  seedStem();
  writeFileSync(join(stateDir, 'stem-cache-usage.json'), JSON.stringify({ v: 1, bytes: 1, dirs: 1 }));
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 2 * DAY });
  assert.ok(!existsSync(join(stateDir, 'stem-cache-usage.json')), 'stale snapshot must be dropped');
});

test('a pass with nothing to do reports zeros and touches nothing', async () => {
  const healthy = seedStem();
  // Drain any earlier leftovers for a clean read of THIS test's effect.
  await purge.runOrphanPurge({ knownIds: [healthy, '_sentinel'], confirm: true, now: NOW_BASE + 400 * DAY });
  const rep = await purge.runOrphanPurge({ knownIds: [healthy, '_sentinel'], confirm: true, now: NOW_BASE + 401 * DAY });
  assert.equal(rep.quarantined, 0);
  assert.equal(rep.deletedCount, 0);
  assert.equal(rep.released.length, 0);
  assert.ok(existsSync(join(ROOT, healthy)));
});

test('a lost marker does not strand an aged quarantine (quarantine present proves the share)', async () => {
  const stranded = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const { rmSync } = await import('node:fs');
  rmSync(join(ROOT, cache.STEMS_MARKER)); // operator lost the marker; cache may even be empty now
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
  assert.ok(rep.deletedCount >= 1);
  assert.ok(!existsSync(join(QU, stranded)));
  writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}'); // restore for later tests
});
