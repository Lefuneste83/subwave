// The pure half of `npm run favourites` (music/favourites-export.ts): which
// hearted songs a run takes and in what order, the file names it writes, and
// the playlist and CSV beside them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csv, fileNames, m3u8, safeName, selectFavourites, type Favourite } from '../src/music/favourites-export.js';

const fav = (id: string, o: Partial<Favourite> = {}): Favourite => ({
  id, artist: 'Artist', title: `Title ${id}`, album: null, year: null, durationSec: 240,
  likes: 1, operator: false, starred: false, lastLikedAt: '2026-10-01T00:00:00Z',
  libraryId: id, matchedBy: 'id', filePath: `/music/A/${id}.flac`, fileSuffix: 'flac', fileSize: 1000, ...o,
});

test('newest heart first; --operator and --min-likes narrow; a star-only song comes last', () => {
  const all = [
    fav('old', { lastLikedAt: '2026-01-01T00:00:00Z' }),
    fav('new', { lastLikedAt: '2026-10-29T00:00:00Z', likes: 3 }),
    fav('op', { lastLikedAt: '2026-05-01T00:00:00Z', operator: true }),
    fav('star', { likes: 0, starred: true, lastLikedAt: null }),
  ];
  assert.deepEqual(selectFavourites(all).map(f => f.id), ['new', 'op', 'old', 'star']);
  assert.deepEqual(selectFavourites(all, { operatorOnly: true }).map(f => f.id), ['op']);
  assert.deepEqual(selectFavourites(all, { minLikes: 2 }).map(f => f.id), ['new']);
});

test('file names are safe on any OS and distinct within the run', () => {
  assert.equal(safeName('AC/DC: "Live" <1979>?'), 'AC_DC_ _Live_ _1979__');
  assert.equal(safeName('  trailing dots... '), 'trailing dots');
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName('x'.repeat(400)).length, 150);
  const names = fileNames([
    fav('a', { artist: 'Sade', title: 'Mr. Wrong' }),
    fav('b', { artist: 'Sade', title: 'Mr. Wrong', fileSuffix: 'FLAC' }),
    fav('c', { artist: null, title: null, fileSuffix: null, filePath: '/x/y.MP3' }),
  ]);
  assert.equal(names.get('a'), 'Sade - Mr. Wrong.flac');
  assert.equal(names.get('b'), 'Sade - Mr. Wrong (2).flac');
  assert.equal(names.get('c'), 'Unknown artist - c.mp3');
});

test('the playlist names the copied files, in order', () => {
  const favs = [fav('a', { artist: 'Sade', title: 'Mr. Wrong', durationSec: 271.6 }), fav('b')];
  const names = fileNames(favs);
  assert.equal(m3u8(favs, names), '#EXTM3U\n#EXTINF:272,Sade - Mr. Wrong\nSade - Mr. Wrong.flac\n#EXTINF:240,Artist - Title b\nArtist - Title b.flac\n');
});

test('a song gone from the library stays in the CSV, out of the playlist', () => {
  const favs = [fav('gone', { libraryId: null, matchedBy: null }), fav('moved', { libraryId: 'new-id', matchedBy: 'name' })];
  const names = fileNames(favs);
  assert.doesNotMatch(m3u8(favs, names), /Title gone/);
  const rows = csv(favs, names).trimEnd().split('\r\n').slice(1);
  assert.match(rows[0]!, /,missing,gone$/);
  assert.match(rows[1]!, /Artist - Title moved\.flac,.*,name,moved$/);
});

test('the CSV quotes what needs it, one row per song', () => {
  const favs = [fav('a', { title: 'Hello, "World"', operator: true })];
  const lines = csv(favs, fileNames(favs)).trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^artist,title,album/);
  assert.match(lines[1]!, /^Artist,"Hello, ""World""",,,240,1,yes,,/);
});
