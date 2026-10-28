// A file replaced at the same path keeps its track id (Navidrome derives the
// id from the path), so the walk's size change is the only signal that the
// audio is new: library-db.upsertTrackMeta clears every audio measurement of
// the track (clearTrackAudio), the facet rows follow, and the walk drops the
// stem files (stem-cache.forgetStems). Metadata, the year and its row stay.
//
// Run: npm test -- replaced-file

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-replaced-file-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const { checkFacets } = await import('../src/music/facet-check.js');
const stems = await import('../src/music/stem-cache.js');

after(async () => { db.close(); await removeTempDir(dir); });

const sql = (q: string) => db.getDb()!.prepare(q);
const rows = (id: string) =>
  (sql('SELECT facet, status FROM track_facet_status WHERE track_id = ? ORDER BY facet').all(id) as Array<{ facet: string; status: string }>)
    .map(r => `${r.facet}:${r.status}`);
const consistent = () => {
  const r = checkFacets();
  assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans }));
};
const meta = (size: number | null) => ({
  title: 'T', artist: 'A', album: 'B', duration: 214, filePath: 'A/B/01 - T.flac', fileSuffix: 'flac', fileSize: size,
});

function measured(id: string) {
  db.upsertTrackMeta(id, meta(1_000));
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  db.writeFacetResults(id, {
    source: 'url',
    loudness: { loudnessLufs: -10, peakDb: -1, samplePeakDb: -1.2, loudnessRangeLu: 6, version: 2 },
    edges: { leadMs: 0, tailMs: 500, durationMs: 214_000 },
  });
  db.upsertTrackAudioVector(id, new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.1));
  sql(`UPDATE tracks SET original_year = 1999, original_year_source = 'manual', stems_at = '2026-10-01T00:00:00Z',
         vocal_ranges_json = '[]', map_x = 1, map_y = 2 WHERE id = ?`).run(id);
  db.syncTrackFacets(id);
}

test('the replacement signal: a different size against a known one', () => {
  assert.equal(db.fileReplaced(1_000, 2_000), true);
  assert.equal(db.fileReplaced(1_000, 1_000), false);
  assert.equal(db.fileReplaced(null, 2_000), false, 'a row walked before file facts existed is not a change');
  assert.equal(db.fileReplaced(1_000, null), false, 'a writer without file facts says nothing about the file');
  assert.equal(db.fileReplaced(0, 2_000), false);
});

test('a walk reporting the same size keeps every measurement', () => {
  measured('same');
  const before = rows('same');
  assert.equal(db.upsertTrackMeta('same', meta(1_000)), false);
  assert.equal(db.upsertTrackMeta('same', { title: 'T' }), false, 'a non-walk writer passes no size');
  assert.deepEqual(rows('same'), before);
  assert.equal(db.getTrack('same')?.bpm, 100);
  consistent();
});

test('a replaced file: its audio analysis is due again, its metadata and year stay', () => {
  measured('swap');
  assert.ok(rows('swap').includes('edges:ok') && rows('swap').includes('clap:ok') && rows('swap').includes('stems:ok'), rows('swap').join());
  assert.equal(db.upsertTrackMeta('swap', meta(2_000)), true);
  const t = sql('SELECT * FROM tracks WHERE id = ?').get('swap') as Record<string, unknown>;
  for (const col of ['bpm', 'musical_key', 'analysis_version', 'loudness_lufs', 'loudness_version', 'decoded_duration_ms',
    'edge_tail_ms', 'outro_json', 'tail_version', 'vocal_ranges_json', 'stems_at', 'audio_moods', 'map_x']) {
    assert.equal(t[col], null, `${col} is cleared`);
  }
  assert.equal(t.file_size, 2_000);
  assert.equal(t.title, 'T');
  assert.equal(t.original_year, 1999, 'the year is not an audio measurement');
  assert.equal(sql('SELECT COUNT(*) AS n FROM track_audio_vectors WHERE id = ?').get('swap')!.n, 0);
  assert.deepEqual(rows('swap'), ['year:ok'], 'no analysis row: every facet is due');
  assert.ok(db.needsAnalysisIds().includes('swap'), 'the next analysis run takes it');
  consistent();
});

test('a settled "silent" answer from the old file does not survive the replacement', () => {
  db.upsertTrackMeta('silent', meta(500));
  db.writeFacetResults('silent', { source: 'url', unmeasurable: { loudness: 'silent', edges: 'silent-file' } } as never);
  sql(`INSERT OR REPLACE INTO track_facet_status (track_id, facet, version, status, reason, attempts, source, at, unmeasurable_reason)
       VALUES ('silent', 'loudness', ?, 'unmeasurable', 'silent', 0, 'url', '2026-10-28', 'silent')`).run(db.FACET_VERSIONS.loudness);
  assert.equal(db.upsertTrackMeta('silent', meta(9_000_000)), true);
  assert.ok(!rows('silent').some(r => r.endsWith(':unmeasurable')), rows('silent').join());
  consistent();
});

test('forgetStems drops the replaced tracks\' stem dirs, and never an offline root', async () => {
  const root = stems.stemsRoot();
  mkdirSync(join(root, 'swap'), { recursive: true });
  writeFileSync(join(root, 'swap', 'head-drums.wav'), 'x');
  mkdirSync(join(root, 'kept'), { recursive: true });
  // No marker, dirs on disk: an existing cache, adopted read-only = online.
  writeFileSync(join(root, stems.STEMS_MARKER), '');
  const r = await stems.forgetStems(['swap', 'absent']);
  assert.deepEqual([r.removed, r.failed], [1, 0]);
  assert.equal(existsSync(join(root, 'swap')), false);
  assert.equal(existsSync(join(root, 'kept')), true, 'only the named tracks');
  assert.deepEqual(await stems.forgetStems([]), { removed: 0, failed: 0 });
});
