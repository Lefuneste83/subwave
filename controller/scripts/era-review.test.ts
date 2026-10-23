// C13 — era-suspect albums: review, reason and export.
//
// The walk already decides an album's era is untrustworthy (era-suspect.ts,
// #1418); this is the operator surface for that decision: the reason and the
// album artist stored at walk time (schema step 32), the per-album override
// table that outlives a walk, the grouped listing the admin Library → Era tab
// reads, the CSV export, and the routes over them.
//
// The walk itself is not run here (it needs Navidrome); the override-aware
// per-song write is era-review.eraWalkFields, the exact computation
// walkNavidrome feeds into upsertTrackMeta, pinned here the way
// scene-vocab.test.ts pins the walk's field mapping.
//
// Run: npm test -- era-review

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'subwave-era-review-'));
process.env.STATE_DIR = dir;
// requireAdmin reads these at import time, so they must be set before the
// route module (and with it middleware/auth.js) is first imported below.
process.env.ADMIN_USER = 'era-test-admin';
process.env.ADMIN_PASS = 'era-test-pass';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const era = await import('../src/music/era-review.js');
const { listen: listenHttp } = await import('./test-utils/http.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
// Clean up at exit rather than an `after()` hook: with this file's mixed
// sync/async top-level tests the root hook was observed firing mid-suite.
// The HTTP server is unref()ed, so it never needs closing for exit.
process.on('exit', () => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const d = () => db.getDb()!;
const cols = () => new Set((d().pragma('table_info(tracks)') as Array<{ name: string }>).map(c => c.name));
const hasTable = (name: string) =>
  !!d().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const row = (id: string) => d()
  .prepare('SELECT era_untrusted, era_reason, album_artist, text_vector_dirty, year, original_year, original_year_checked_at FROM tracks WHERE id = ?')
  .get(id) as { era_untrusted: number | null; era_reason: string | null; album_artist: string | null; text_vector_dirty: number; year: number | null; original_year: number | null; original_year_checked_at: string | null } | undefined;

// ── (a) schema step 32 ───────────────────────────────────────────────────────

test('step 32 adds era_reason, album_artist and the era_override table on an older db', () => {
  // A fresh open already ran every step; wind the db back to before 32 by
  // removing exactly what that step owns, then reopen and watch it rebuild.
  assert.equal(d().pragma('user_version', { simple: true }) as number >= 32, true);
  d().exec(`
    DROP TABLE era_override;
    ALTER TABLE tracks DROP COLUMN era_reason;
    ALTER TABLE tracks DROP COLUMN album_artist;
  `);
  d().pragma('user_version = 31');
  assert.equal(cols().has('era_reason'), false);
  assert.equal(hasTable('era_override'), false);

  db.close();
  return db.open({ embeddingDim: 8, adoptStoredDim: true }).then(() => {
    assert.equal(cols().has('era_reason'), true);
    assert.equal(cols().has('album_artist'), true);
    assert.equal(hasTable('era_override'), true);
    assert.equal(d().pragma('user_version', { simple: true }) as number, 32);
    // Re-running the step must not throw (ADD COLUMN on an existing column does).
    assert.equal(cols().has('era_reason'), true);
  });
});

test('era_override refuses a verdict outside trusted/suspect', () => {
  assert.throws(() => d()
    .prepare(`INSERT INTO era_override(album_key, verdict, set_at) VALUES ('k', 'maybe', 'now')`)
    .run());
});

// ── (b) the walk persists reason and album artist ────────────────────────────

test('upsertTrackMeta stores era_reason and album_artist, and a writer without them keeps them', () => {
  db.upsertTrackMeta('p1', {
    title: 'Song', artist: 'Someone', album: 'Greatest Hits',
    eraUntrusted: true, eraReason: 'title-compilation', albumArtist: 'Someone',
  });
  assert.deepEqual(row('p1') && {
    era_untrusted: row('p1')!.era_untrusted,
    era_reason: row('p1')!.era_reason,
    album_artist: row('p1')!.album_artist,
  }, { era_untrusted: 1, era_reason: 'title-compilation', album_artist: 'Someone' });
  // A manual edit or analyzer top-up has neither; COALESCE keeps them.
  db.upsertTrackMeta('p1', { title: 'Song (single edit)' });
  assert.equal(row('p1')!.era_reason, 'title-compilation');
  assert.equal(row('p1')!.album_artist, 'Someone');
  // Neutralise it so the listing fixtures below count only their own albums.
  db.upsertTrackMeta('p1', { eraUntrusted: false });
});

// ── (c) the override-aware walk write ────────────────────────────────────────

test('a trusted override stores 0 while the walk reason survives', () => {
  const overrides = new Map([[era.albumEraKey('Various Artists', 'Summer 1998'), 'trusted' as const]]);
  const f = era.eraWalkFields({
    albumArtist: 'Various Artists', album: 'Summer 1998',
    albumEraUntrusted: true, albumEraReason: 'various-artists',
  }, overrides);
  assert.deepEqual(f, { eraUntrusted: false, eraReason: 'various-artists', albumArtist: 'Various Artists' });
  db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
  assert.equal(row('w1')!.era_untrusted, 0);
  assert.equal(row('w1')!.era_reason, 'various-artists', 'the walk reason is audit truth, the override never rewrites it');
});

test('a suspect override flips a walk verdict that was clear', () => {
  const overrides = new Map([[era.albumEraKey('Solo Artist', 'The Anthology 1970-1975'), 'suspect' as const]]);
  const f = era.eraWalkFields({
    albumArtist: 'Solo Artist', album: 'The Anthology 1970-1975',
    albumEraUntrusted: false, albumEraReason: null,
  }, overrides);
  assert.equal(f.eraUntrusted, true);
  assert.equal(f.eraReason, null);
});

// ── (d) the override survives repeated walks ─────────────────────────────────

test('trusted override survives a second walk and a third', () => {
  const overrides = new Map([[era.albumEraKey('Various Artists', 'Summer 1998'), 'trusted' as const]]);
  for (let i = 0; i < 2; i++) {
    const f = era.eraWalkFields({
      albumArtist: 'Various Artists', album: 'Summer 1998',
      albumEraUntrusted: true, albumEraReason: 'various-artists',
    }, overrides);
    db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
    assert.equal(row('w1')!.era_untrusted, 0, `walk ${i + 2}`);
  }
  // Without the override in the map (i.e. after a Reset), the same walk flips
  // the row back — that is how Reset takes effect.
  const f = era.eraWalkFields({
    albumArtist: 'Various Artists', album: 'Summer 1998',
    albumEraUntrusted: true, albumEraReason: 'various-artists',
  }, new Map());
  db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
  assert.equal(row('w1')!.era_untrusted, 1);
  // Put it back for the listing fixtures below.
  db.upsertTrackMeta('w1', { eraUntrusted: false });
});

// ── (e) setEraOverride applies immediately ───────────────────────────────────

test('setEraOverride flips existing rows at once and marks text_vector_dirty only where the value actually changes', () => {
  // Four tracks on one album key, in each stored state, all clean to start.
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, text_vector_dirty)
    VALUES
      ('x1', 'One',   'QA', 'QA Album', 'QA Artist', 1,    'compilation-flag', 0),
      ('x2', 'Two',   'QA', 'QA Album', 'QA Artist', 1,    'compilation-flag', 0),
      ('x3', 'Three', 'QA', 'QA Album', 'QA Artist', 0,    NULL,               0),
      ('x4', 'Four',  'QA', 'QA Album', 'QA Artist', NULL, NULL,               0);
  `);
  const key = era.albumEraKey('QA Artist', 'QA Album');
  const affected = era.setEraOverride(d(), key, 'trusted');
  // x3 was already 0: not flipped, not dirty. x1, x2, x4 all change value.
  assert.equal(affected, 3);
  assert.equal(row('x1')!.era_untrusted, 0);
  assert.equal(row('x1')!.text_vector_dirty, 1);
  assert.equal(row('x2')!.text_vector_dirty, 1);
  assert.equal(row('x3')!.text_vector_dirty, 0, 'already trusted: untouched');
  assert.equal(row('x4')!.era_untrusted, 0, 'NULL means no evidence, trusted normalizes it to 0');
  assert.equal(row('x4')!.text_vector_dirty, 1);
  // And the override itself is recorded, so the next walk agrees.
  assert.equal(era.loadEraOverrides(d()).get(key), 'trusted');

  // Suspect over a trusted row flips it the other way.
  assert.equal(era.setEraOverride(d(), key, 'suspect'), 4);
  assert.equal(row('x3')!.era_untrusted, 1);
  assert.equal(row('x3')!.text_vector_dirty, 1);
  assert.equal(row('x1')!.text_vector_dirty, 1, 'stays dirty; no second marking needed');
});

test('Reset removes the override without silently touching existing rows; the next walk restores the walk verdict', () => {
  const key = era.albumEraKey('QA Artist', 'QA Album');
  era.setEraOverride(d(), key, 'trusted');
  assert.equal(row('x1')!.era_untrusted, 0);
  const removed = era.setEraOverride(d(), key, null);
  assert.equal(removed, 1, 'one override row deleted');
  assert.equal(era.loadEraOverrides(d()).has(key), false);
  // The deliberate behaviour: rows stay as they are until the next walk,
  // which writes the (un-overridden) walk verdict again.
  assert.equal(row('x1')!.era_untrusted, 0);
  const f = era.eraWalkFields(
    { albumArtist: 'QA Artist', album: 'QA Album', albumEraUntrusted: true, albumEraReason: 'compilation-flag' },
    era.loadEraOverrides(d()),
  );
  assert.equal(f.eraUntrusted, true, 'with no override, the walk verdict rules again');
  // Resetting a key with no override is a no-op, not an error.
  assert.equal(era.setEraOverride(d(), era.albumEraKey('Nobody', 'Nowhere'), null), 0);
});

// ── (f) listing + summary ────────────────────────────────────────────────────

test('listEraAlbums groups by (album, album_artist) over suspect-or-overridden tracks, biggest first', () => {
  // Album "QA Album" (4 tracks) sits un-overridden and trusted from the Reset
  // test above; make it suspect again through the override, so it is listed
  // with `overridden` set. Add a two-track override album and an ordinary
  // album that must never appear.
  era.setEraOverride(d(), era.albumEraKey('QA Artist', 'QA Album'), 'suspect');
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason)
    VALUES
      ('g1', 'G1', 'Band L', 'Lounging 1970-1975', 'Band L', 1, 'title-year-range'),
      ('g2', 'G2', 'Band L', 'Lounging 1970-1975', 'Band L', 1, 'title-year-range'),
      ('g3', 'G3', 'Ordinary', 'Normal Album',     'Ordinary', 0, NULL);
  `);
  era.setEraOverride(d(), era.albumEraKey('Band L', 'Lounging 1970-1975'), 'trusted');
  era.setEraOverride(d(), era.albumEraKey('Band L', 'Lounging 1970-1975'), 'suspect');

  const albums = era.listEraAlbums(d());
  const qa = albums.find(a => a.album === 'QA Album')!;
  assert.equal(qa.albumKey, era.albumEraKey('QA Artist', 'QA Album'));
  assert.equal(qa.albumArtist, 'QA Artist');
  assert.equal(qa.tracks, 4);
  assert.equal(qa.reason, 'compilation-flag');
  assert.equal(qa.overridden, true);
  const ll = albums.find(a => a.album === 'Lounging 1970-1975')!;
  assert.equal(ll.tracks, 2);
  assert.equal(ll.overridden, true);
  // year_state tallies: g-rows are unchecked (no original_year, no stamp);
  // give x1 a resolved year and x2 a not-found stamp.
  d().prepare(`UPDATE tracks SET original_year = 1971 WHERE id = 'x1'`).run();
  d().prepare(`UPDATE tracks SET original_year_checked_at = '2026-10-01T00:00:00Z' WHERE id = 'x2'`).run();
  const qa2 = era.listEraAlbums(d()).find(a => a.album === 'QA Album')!;
  assert.equal(qa2.yearResolved, 1);
  assert.equal(qa2.yearNotFound, 1);
  assert.equal(qa2.yearUnchecked, 2);
  // Ordinary albums never show up.
  assert.equal(albums.some(a => a.album === 'Normal Album'), false);
  // Ordered by track count descending.
  const counts = era.listEraAlbums(d()).map(a => a.tracks);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

  const summary = era.countEraSummary(d());
  assert.equal(summary.albums, 2);
  assert.equal(summary.tracks, 6);
  assert.equal(summary.overridden, 2);
  // byReason counts tracks per stored walk reason; x3/x4 and the g-rows'
  // NULL-reason tracks appear in `tracks` but under no reason key.
  assert.deepEqual(summary.byReason, { 'compilation-flag': 2, 'title-year-range': 2 });
});

// ── (g) CSV export ───────────────────────────────────────────────────────────

test('exportEraCsv: RFC4180 header, quoting, and year_state values', () => {
  // A title with a comma and a quote exercises both halves of RFC4180 here.
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, year, original_year, file_path, file_suffix, bit_rate, file_size, duration_sec)
    VALUES
      ('c1', 'Hello, "World"', 'QA', 'QA Album', 'QA Artist', 1, 'compilation-flag', 2020, NULL, '/m/qa/01.flac', 'flac', 900, 12345, 210),
      ('c2', 'Plain',          'QA', 'QA Album', 'QA Artist', 1, 'compilation-flag', 2020, 1971, '/m/qa/02.flac', 'flac', 900, 12346, 180);
  `);
  const csv = era.exportEraCsv(d());
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(
    lines[0],
    'id,artist,title,album,album_artist,era_reason,overridden,year,original_year,year_state,file_path,file_suffix,bit_rate,file_size,duration_sec',
  );
  assert.ok(lines.some(l => l.includes('"Hello, ""World"""')), 'comma/quote title is quoted and escaped');
  const c1 = lines.find(l => l.startsWith('c1,'))!;
  const c2 = lines.find(l => l.startsWith('c2,'))!;
  assert.ok(c1.includes(',unchecked,'), 'no original year and no lookup stamp reads unchecked');
  assert.ok(c2.includes(',resolved,'), 'a resolved original year reads resolved');
  // A checked miss reads not found.
  d().prepare(`UPDATE tracks SET original_year_checked_at = '2026-10-01T00:00:00Z' WHERE id = 'c1'`).run();
  assert.ok(era.exportEraCsv(d()).split('\r\n').find(l => l.startsWith('c1,'))!.includes(',not found,'));
  // Ordinary albums are not in the export.
  assert.equal(era.exportEraCsv(d()).split('\r\n').some(l => l.includes('Normal Album')), false);
});

// ── (h) routes ───────────────────────────────────────────────────────────────

const { router: eraRoutes } = await import('../src/routes/library/era.js');
const app = express();
app.use(express.json());
app.use(eraRoutes);
const { server, url: base } = await listenHttp(app);
server.unref();

const auth = `Basic ${Buffer.from('era-test-admin:era-test-pass').toString('base64')}`;

test('routes answer 401 without admin credentials', async () => {
  assert.equal((await fetch(`${base}/library/era`)).status, 401);
  assert.equal((await fetch(`${base}/library/era/csv`)).status, 401);
  assert.equal((await fetch(`${base}/library/era/override`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album: 'QA Album', verdict: 'trusted' }),
  })).status, 401);
});

test('GET /library/era returns { summary, albums }', async () => {
  const res = await fetch(`${base}/library/era`, { headers: { authorization: auth } });
  if (res.status !== 200) throw new Error(`body: ${await res.text()}`);
  const body = await res.json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['albums', 'summary']);
  assert.equal(body.summary.albums, 2);
  assert.equal(body.albums.find((a: any) => a.album === 'QA Album').tracks, 6); // c1+c2 joined QA
  assert.equal(body.albums.every((a: any) => typeof a.albumKey === 'string'), true);
});

test('POST /library/era/override trusts, suspects and removes; respond carries {ok, affected}', async () => {
  const post = (body: unknown) => fetch(`${base}/library/era/override`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'trusted' });
  assert.equal(res.status, 200);
  let out = await res.json() as any;
  assert.deepEqual(Object.keys(out).sort(), ['affected', 'ok']);
  assert.equal(out.ok, true);
  assert.equal(out.affected, 2, 'both g-rows flipped to trusted');
  assert.equal(row('g1')!.era_untrusted, 0);

  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: null });
  out = await res.json() as any;
  assert.equal(out.ok, true);
  assert.equal(out.affected, 1, 'removal counts the override row dropped');
  assert.equal(era.loadEraOverrides(d()).has(era.albumEraKey('Band L', 'Lounging 1970-1975')), false);

  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'maybe' });
  assert.equal(res.status, 400);
  res = await post({ albumArtist: 'Band L', verdict: 'trusted' });
  assert.equal(res.status, 400, 'album is required');
});

test('GET /library/era/csv streams the export with a download filename', async () => {
  const res = await fetch(`${base}/library/era/csv`, { headers: { authorization: auth } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="era-suspects.csv"');
  const text = await res.text();
  assert.ok(text.startsWith('id,artist,title,'));
  assert.ok(text.includes('QA Album'));
});
