// The Navidrome walk keeps a few getAlbum calls in flight ahead of the album it
// is reading, and writes each album's rows in one transaction. Neither may
// change what the walk sees or stores: it stays the authoritative listing the
// prune and the replaced-file check trust.
//
// Pinned here, against a fake Navidrome that answers slowly:
//   - at most NAVIDROME_WALK_CONCURRENCY calls are in flight (default 4,
//     bounded 1-16), and more than one is, so the round trips overlap;
//   - the songs come out in listing order, identical to a one-at-a-time walk;
//   - a complete walk (requireComplete) still stops on the failing album with
//     exactly the songs before it, and a best-effort one skips just that album;
//   - walkNavidrome stores the same rows and live ids at concurrency 4 as at 1,
//     and a walk that cannot read an album throws instead of returning a
//     partial live set (so nothing is pruned).
// Run: `npm test -- walk-concurrency`.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const ALBUMS = 23;
let failAlbum: string | null = null;
let latencyMs = 15;
let inFlight = 0;
let peak = 0;
const songsOf = (i: number) => Array.from({ length: 1 + (i % 4) }, (_, j) => ({
  id: `s${i}-${j}`, title: `Song ${i}.${j}`, artist: `Artist ${i % 5}`, album: `Album ${i}`, albumId: `al${i}`,
  year: 1990 + i, duration: 200 + j, path: `/music/${i}/${j}.flac`, suffix: 'flac', size: 1_000_000 + i * 10 + j, bitRate: 900,
}));
const navidrome = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const endpoint = url.pathname.split('/').at(-1);
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, latencyMs));
  inFlight -= 1;
  const body: Record<string, unknown> = { status: 'ok' };
  if (endpoint === 'getAlbumList2') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    body.albumList2 = { album: offset ? [] : Array.from({ length: ALBUMS }, (_, i) => ({ id: `al${i}`, name: `Album ${i}`, artist: `Artist ${i % 5}` })) };
  } else if (endpoint === 'getAlbum') {
    const id = url.searchParams.get('id')!;
    if (id === failAlbum) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    const i = Number(id.slice(2));
    body.album = { id, name: `Album ${i}`, artist: `Artist ${i % 5}`, song: songsOf(i) };
  } else {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': body }));
});
await new Promise<void>((resolve) => navidrome.listen(0, '127.0.0.1', resolve));
process.env.NAVIDROME_URL = `http://127.0.0.1:${(navidrome.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const dir = createTempDir(join(tmpdir(), 'subwave-walk-concurrency-'));
process.env.STATE_DIR = dir;
const subsonic = await import('../src/music/subsonic.js');
const db = await import('../src/music/library-db.js');
const { walkNavidrome } = await import('../src/music/tag-library/flags.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => {
  db.close();
  navidrome.closeAllConnections();
  await new Promise((resolve) => navidrome.close(resolve));
  await removeTempDir(dir);
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = [console.error, console.log];
  console.error = () => {};
  console.log = () => {};
  try { return await fn(); } finally { [console.error, console.log] = saved; }
};

async function walkIds(concurrency: number, requireComplete: boolean): Promise<{ ids: string[]; error: string | null }> {
  const prev = process.env.NAVIDROME_WALK_CONCURRENCY;
  process.env.NAVIDROME_WALK_CONCURRENCY = String(concurrency);
  peak = 0;
  const ids: string[] = [];
  try {
    await quiet(async () => {
      for await (const s of subsonic.iterateAllSongs({ requireComplete })) ids.push(String(s.id));
    });
    return { ids, error: null };
  } catch (err) {
    return { ids, error: (err as Error).message };
  } finally {
    if (prev === undefined) delete process.env.NAVIDROME_WALK_CONCURRENCY;
    else process.env.NAVIDROME_WALK_CONCURRENCY = prev;
  }
}

const expected = Array.from({ length: ALBUMS }, (_, i) => songsOf(i).map((s) => s.id)).flat();

test('the walk concurrency is bounded 1-16 and defaults to 4', () => {
  const prev = process.env.NAVIDROME_WALK_CONCURRENCY;
  try {
    delete process.env.NAVIDROME_WALK_CONCURRENCY;
    assert.equal(subsonic.walkConcurrency(), 4);
    process.env.NAVIDROME_WALK_CONCURRENCY = '0';
    assert.equal(subsonic.walkConcurrency(), 1);
    process.env.NAVIDROME_WALK_CONCURRENCY = '99';
    assert.equal(subsonic.walkConcurrency(), 16);
    process.env.NAVIDROME_WALK_CONCURRENCY = 'lots';
    assert.equal(subsonic.walkConcurrency(), 4);
  } finally {
    if (prev === undefined) delete process.env.NAVIDROME_WALK_CONCURRENCY;
    else process.env.NAVIDROME_WALK_CONCURRENCY = prev;
  }
});

test('albums are fetched ahead, never more than the bound, and read in listing order', async () => {
  failAlbum = null;
  const serial = await walkIds(1, true);
  assert.equal(peak, 1, 'one at a time at concurrency 1');
  const ahead = await walkIds(4, true);
  assert.ok(peak > 1, `round trips overlap (peak ${peak})`);
  assert.ok(peak <= 4, `never more than 4 in flight (peak ${peak})`);
  assert.deepEqual(serial, { ids: expected, error: null });
  assert.deepEqual(ahead, { ids: expected, error: null });
});

test('a complete walk stops on the failing album with exactly the songs before it', async () => {
  failAlbum = 'al9';
  const before = Array.from({ length: 9 }, (_, i) => songsOf(i).map((s) => s.id)).flat();
  for (const c of [1, 4]) {
    const r = await walkIds(c, true);
    assert.deepEqual(r.ids, before, `concurrency ${c}`);
    assert.match(r.error ?? '', /Incomplete Navidrome walk: album al9/);
  }
  failAlbum = null;
});

test('a best-effort walk skips only the failing album', async () => {
  failAlbum = 'al9';
  const rest = expected.filter((id) => !id.startsWith('s9-'));
  for (const c of [1, 4]) assert.deepEqual(await walkIds(c, false), { ids: rest, error: null }, `concurrency ${c}`);
  failAlbum = null;
});

const dump = () => db.getDb()!.prepare(
  `SELECT id, title, artist, album, album_id, year, duration_sec, file_path, file_suffix, file_size, bit_rate, album_artist
     FROM tracks ORDER BY id`,
).all();

test('walkNavidrome stores the same rows at concurrency 4 as at 1, and a failed walk throws', async () => {
  failAlbum = null;
  latencyMs = 2;
  process.env.NAVIDROME_WALK_CONCURRENCY = '1';
  const serial = await quiet(() => walkNavidrome({ confirmReplaced: false, acceptReplaced: false }));
  const serialRows = dump();
  db.getDb()!.exec('DELETE FROM tracks');
  process.env.NAVIDROME_WALK_CONCURRENCY = '4';
  const ahead = await quiet(() => walkNavidrome({ confirmReplaced: false, acceptReplaced: false }));
  assert.equal(ahead.walked, expected.length);
  assert.equal(serial.walked, expected.length);
  assert.deepEqual([...ahead.liveIds], [...serial.liveIds]);
  assert.deepEqual(dump(), serialRows);
  assert.equal(serialRows.length, expected.length);

  failAlbum = 'al15';
  await assert.rejects(quiet(() => walkNavidrome({ confirmReplaced: false, acceptReplaced: false })), /Incomplete Navidrome walk: album al15/);
  failAlbum = null;
  delete process.env.NAVIDROME_WALK_CONCURRENCY;
  latencyMs = 15;
});
