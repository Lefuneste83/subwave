// C15 — the Library page's counts line (music/library-overview.ts): library =
// can air + never play, the split by what blocks a row, DJ-ready, the show's
// length limits, the play-history reach, and the cache that keeps every play's
// commit from recounting the library per poll.
//
// Run: npm test -- library-overview

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-library-overview-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const blocklist = await import('../src/music/blocklist.js');
await blocklist.load();
const settings = await import('../src/settings.js');
await settings.load();
const ov = await import('../src/music/library-overview.js');
const era = await import('../src/music/era-review.js');

after(async () => { db.close(); await removeTempDir(dir); });

const d = () => db.getDb()!;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T12:00:00Z');

function track(id: string, o: Partial<Record<string, unknown>> = {}) {
  const r = {
    id, title: `T ${id}`, artist: 'Artist', album: 'Album', album_id: `al-${id}`, artist_id: 'ar-1',
    genres: '["rock"]', moods: '["calm"]', bpm: 120, musical_key: 'C major',
    loudness_lufs: -9, loudness_version: 2, duration_sec: 240, ...o,
  };
  const keys = Object.keys(r);
  d().prepare(`INSERT INTO tracks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => (r as any)[k]));
}

function play(trackId: string, at: number) {
  db.recordPlay({ trackId, title: 't', artist: 'a', album: 'b', playedAt: new Date(at).toISOString(), source: 'dj', requestedBy: null, showId: null, showName: null } as any);
}

beforeEach(async () => {
  d().exec('DELETE FROM tracks; DELETE FROM plays;');
  for (const e of blocklist.list()) await blocklist.remove(e.type, e.id);
  for (const r of blocklist.listRules()) await blocklist.removeRule(r.id);
  ov._resetOverviewCache();
});

test('library = can air + never play, and blocked rows split by what blocks them', async () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) track(id);
  track('g', { album: 'Gone', album_id: 'al-gone' });
  track('h', { album: 'Gone', album_id: 'al-gone2' });
  track('i', { genres: '["polka"]' });
  await blocklist.add({ type: 'track', id: 'a' });
  // Album entry by id, and its name fallback for a copy with another album id.
  await blocklist.add({ type: 'album', id: 'al-gone', name: 'Gone', artist: 'Artist' });
  await blocklist.addRule({ label: 'No polka', field: 'genre', values: ['polka'] });

  const o = ov.computeOverview(NOW);
  assert.equal(o.library, 9);
  assert.deepEqual(o.blocked, { total: 4, track: 1, album: 2, artist: 0, rule: 1 });
  assert.equal(o.canAir, 5);
  assert.equal(o.library, o.canAir + o.blocked.total);
});

test('DJ-ready needs moods, BPM, key and a whole-file loudness; blocked rows never count', async () => {
  track('ok');
  track('nomood', { moods: null });
  track('nobpm', { bpm: null });
  track('nokey', { musical_key: null });
  track('window-loudness', { loudness_version: 1 });
  track('blocked');
  await blocklist.add({ type: 'track', id: 'blocked' });
  const o = ov.computeOverview(NOW);
  assert.equal(o.djReady, 1);
  assert.equal(o.taggedCanAir, 4, 'tagged = has moods, among what can air');
});

test('aired counts distinct tracks that can air, in the window and ever', async () => {
  for (const id of ['a', 'b', 'c', 'd']) track(id);
  await blocklist.add({ type: 'track', id: 'd' });
  play('a', NOW - 1 * DAY);
  play('a', NOW - 2 * DAY);
  play('b', NOW - 40 * DAY);
  play('d', NOW - 1 * DAY); // blocked since: not part of what can air
  play('gone', NOW - 1 * DAY); // no longer in the library
  const o = ov.computeOverview(NOW);
  assert.deepEqual(
    { recent: o.aired.recent, ever: o.aired.ever, never: o.aired.never, windowDays: o.aired.windowDays },
    { recent: 1, ever: 2, never: 1, windowDays: 30 },
  );
  assert.equal(o.aired.since, new Date(NOW - 40 * DAY).toISOString());
});

test('no length limit in force reads null; the pure summary counts what passes floor and cap', () => {
  assert.equal(ov.computeOverview(NOW).lengthLimits, null);
  const rows = [100, 300, 700, null].map((s, i) => ({
    id: String(i), title: null, artist: null, album: null, albumId: null, artistId: null, genres: null,
    genre: null, moods: null, audioMoods: null, lastfmTags: null, durationSec: s, tagged: true, ready: true,
  }));
  const s = ov.summariseRows(rows, () => null, { minSec: 120, maxSec: 600 });
  assert.equal(s.within, 2, '300 s and the unknown length pass; 100 s and 700 s do not');
});

test('the needs-you sum adds analysis failures, unmeasurable facets (not year) and failed year lookups', () => {
  track('x');
  track('y');
  d().prepare('UPDATE tracks SET analyze_fail_count = 99 WHERE id = ?').run('x');
  d().exec('DELETE FROM track_facet_status');
  const ins = d().prepare(`INSERT INTO track_facet_status (track_id, facet, status, version, attempts, at) VALUES (?, ?, ?, 1, 1, '2026-10-27')`);
  ins.run('x', 'loudness', 'unmeasurable');
  ins.run('x', 'tail', 'unmeasurable'); // the same damaged file, a second facet
  ins.run('y', 'year', 'unmeasurable');
  ins.run('x', 'year', 'failed');
  const a = ov.computeOverview(NOW).attention;
  assert.equal(a.analysisFailed, 1);
  assert.equal(a.unmeasurable, 1, 'one track, however many facets; year has its own surface, the Era tab');
  assert.equal(a.yearFailed, 1);
  assert.equal(a.total, a.eraAlbums + a.unmeasurable + a.yearFailed + a.analysisFailed);

  // The CSV lists exactly the tracks the tile counts, one row per track and issue.
  d().prepare(`UPDATE track_facet_status SET unmeasurable_reason = 'silent' WHERE track_id = 'x' AND facet = 'loudness'`).run();
  d().prepare(`UPDATE tracks SET file_path = '/music/A/x, "live".flac', analyze_error = 'decode error' WHERE id = 'x'`).run();
  const lines = ov.exportAttentionCsv(d()).trimEnd().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'issue');
  const body = lines.slice(1);
  assert.equal(body.length, a.unmeasurable + a.yearFailed + a.analysisFailed);
  assert.deepEqual(body.map(l => l.split(',')[0]), ['analysis-gave-up', 'unreadable', 'year-lookup-failed']);
  const unreadable = body.find(l => l.startsWith('unreadable'))!;
  assert.match(unreadable, /loudness: silent/);
  assert.match(unreadable, /tail: not measured/);
  assert.match(unreadable, /"\/music\/A\/x, ""live"".flac"/, 'a path with a comma and quotes stays one RFC4180 field');
  assert.match(body[0], /decode error \(99 failures\)/);
  assert.ok(!body.some(l => l.includes(',y,')), 'a year nobody knows is the Era tab\'s, not this list\'s');
});

test('the page never waits: the first read is null and starts a refresh, later reads serve the snapshot', async () => {
  track('a');
  track('b');
  assert.equal(ov.getOverview('', Date.now()), null, 'nothing counted yet, and the read did not count');
  await ov._settled();
  assert.equal(ov.getOverview('', Date.now())!.canAir, 2);
});

test('a play-sized commit waits out the minute; a never-play edit is seen on the next poll', async () => {
  track('a');
  track('b');
  await ov.refreshOverview();
  const t0 = Date.now();
  track('c'); // a commit: the change token moves
  ov.getOverview('', t0 + 1000);
  await ov._settled();
  assert.equal(ov.getOverview('', t0 + 1000)!.canAir, 2, 'held for MIN_RECOUNT_MS');
  await blocklist.add({ type: 'track', id: 'a' });
  ov.getOverview('', t0 + 2000);
  await ov._settled();
  assert.equal(ov.getOverview('', t0 + 2000)!.canAir, 2, 'list edit seen: c added, a blocked');
  assert.equal(ov.getOverview('', t0 + 2000)!.blocked.track, 1);
});

test('the row pass and the era count read their indexes, never the wide rows (#1937)', () => {
  const plan = (sql: string) => (d().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail).join(' | ');
  assert.match(plan(ov.overviewRowsSql()), /COVERING INDEX idx_tracks_overview/);
  d().exec('ANALYZE');
  assert.match(plan(ov.overviewRowsSql()), /COVERING INDEX idx_tracks_overview/, 'still chosen once ANALYZE has run');
});

test('albums to review are exactly the Era tab\'s "To review"', () => {
  // Untrusted, no decision, a track without a year: to review.
  track('a1', { era_untrusted: 1, album_artist: 'A', album: 'One' });
  track('a2', { era_untrusted: 1, album_artist: 'A', album: 'One', original_year: 1971 });
  // Untrusted, no decision, but every track has a year: done, though never decided.
  track('b1', { era_untrusted: 1, album_artist: 'B', album: 'Two', original_year: 1980 });
  // Decided per track ('suspect') and one track still without a year: to review.
  track('c1', { era_untrusted: 1, album_artist: 'C', album: 'Three' });
  // Trusted: done.
  track('d1', { era_untrusted: 1, album_artist: 'D', album: 'Four' });
  // A kind set and nothing else: no decision, so still to review.
  track('e1', { era_untrusted: 1, album_artist: 'E', album: 'Five' });
  era.setEraOverride(d(), era.albumEraKey('C', 'Three'), 'suspect');
  era.setEraOverride(d(), era.albumEraKey('D', 'Four'), 'trusted');
  era.setEraKind(d(), era.albumEraKey('E', 'Five'), 'live');
  const listed = era.listEraAlbums(d()).filter(x => !x.done).map(x => x.albumKey).sort();
  assert.deepEqual(listed, [era.albumEraKey('A', 'One'), era.albumEraKey('C', 'Three'), era.albumEraKey('E', 'Five')].sort());
  assert.equal(era.countEraToReview(d()), listed.length);
  assert.equal(ov.computeOverview(NOW).attention.eraAlbums, listed.length);
});
