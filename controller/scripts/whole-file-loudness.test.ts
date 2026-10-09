// Whole-file loudness (B13): the pass that replaces the analysis window's
// loudness/peak (first ANALYZE_SECONDS at ANALYZE_SR, sample peak) with
// integrated loudness + TRUE peak over the whole file.
//
// The contracts pinned here:
//   - loudness and peak are ONE measurement: written together or not at all,
//     both on the wire (parseWholeFileLoudness) and in the table;
//   - a whole-file figure outranks the window's: a later head re-analysis, and a
//     --re-analyze clear, never put the window's figures back;
//   - the scope goes quietest-reading first (the tracks boosted hardest today),
//     skips stamped tracks, and drops a track after MAX_LOUDNESS_ATTEMPTS
//     consecutive failures;
//   - the pass is off unless ANALYZE_WHOLE_FILE_LOUDNESS is set, is never sent
//     to a sidecar that does not advertise it, and an outage (a run of
//     failures) is stamped against nobody.
//
// Real better-sqlite3 DB in a temp STATE_DIR and a fake analyzer sidecar on
// localhost, so the pass runs end to end through analyzer.ts.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

type Db = typeof import('../src/music/library-db.js');
type Analyze = typeof import('../src/music/analyze.js');
type Analyzer = typeof import('../src/music/analyzer.js');

// Per-id answers of the fake sidecar's POST /loudness, keyed by the song id in
// the stream url. 'fail' → HTTP 500.
const answers = new Map<string, Record<string, unknown> | 'fail'>();
const requested: string[] = [];
let advertise = true;

const sidecar = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engines: ['analyze'], ...(advertise ? { analyze_loudness_capable: true } : {}) }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/loudness') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string };
  const id = new URL(body.url || 'http://x/').searchParams.get('id') || '';
  requested.push(id);
  const a = answers.get(id);
  if (!a || a === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: `ffmpeg exited 1: cannot open ${id}` }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, seconds: 2.5, ...a }));
});

let db: Db;
let analyze: Analyze;
let analyzer: Analyzer;

before(async () => {
  await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const address = sidecar.address();
  assert.ok(address && typeof address === 'object');
  process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
  process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-whole-loudness-'));
  process.env.ANALYZE_WHOLE_FILE_LOUDNESS = '1';
  process.env.ANALYZE_LOUDNESS_CONCURRENCY = '1';
  db = await import('../src/music/library-db.js');
  analyze = await import('../src/music/analyze.js');
  analyzer = await import('../src/music/analyzer.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
});

after(async () => {
  analyzer?.shutdown();
  db?.close();
  await new Promise<void>((resolve, reject) => sidecar.close((err) => (err ? reject(err) : resolve())));
});

function seed(id: string, lufs: number | null, peak: number | null) {
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  if (lufs !== null) db.upsertTrackAnalysis(id, { bpm: 120, loudnessLufs: lufs, peakDb: peak });
}

function row(id: string) {
  return db.getDb()!
    .prepare('SELECT loudness_lufs, peak_db, loudness_version, loudness_attempts FROM tracks WHERE id = ?')
    .get(id) as { loudness_lufs: number | null; peak_db: number | null; loudness_version: number | null; loudness_attempts: number | null };
}

test('the columns are added by name, without claiming a user_version', async () => {
  const cols = () => (db.getDb()!.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(c => c.name);
  assert.ok(cols().includes('loudness_version'));
  assert.ok(cols().includes('loudness_attempts'));
  const version = db.getDb()!.pragma('user_version', { simple: true });
  // Re-opening a database that already has them is harmless, and moves no
  // numbered migration.
  db.close();
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
  assert.equal(cols().filter(c => c.startsWith('loudness_')).length, 3);
  assert.equal(db.getDb()!.pragma('user_version', { simple: true }), version);
});

test('the wire coerces loudness and peak as a pair', () => {
  assert.deepEqual(
    analyzer.parseWholeFileLoudness({ ok: true, loudness_lufs: -12.1, true_peak_db: 0.4, sample_peak_db: 0.1, lra_lu: 6, seconds: 2 }),
    { loudnessLufs: -12.1, truePeakDb: 0.4, samplePeakDb: 0.1, lraLu: 6, seconds: 2 },
  );
  const lone = analyzer.parseWholeFileLoudness({ ok: true, loudness_lufs: -12.1, true_peak_db: null });
  assert.equal(lone.loudnessLufs, null, 'a loudness without its peak is no measurement');
  assert.equal(lone.truePeakDb, null);
  assert.throws(() => analyzer.parseWholeFileLoudness({ ok: false, error: 'boom' }), /boom/);
});

test('the table refuses a lone figure and stamps a measured silence', () => {
  seed('silent', -40, -30);
  assert.throws(() => db.recordWholeFileLoudness('silent', { loudnessLufs: -20, truePeakDb: null }), /both/);
  db.recordWholeFileLoudness('silent', { loudnessLufs: null, truePeakDb: null });
  assert.deepEqual(row('silent'), { loudness_lufs: null, peak_db: null, loudness_version: db.WHOLE_FILE_LOUDNESS_VERSION, loudness_attempts: null });
});

test('a head re-analysis never puts the window figures back over a whole-file measurement', () => {
  seed('kate', -22.26, -6.05);
  db.recordWholeFileLoudness('kate', { loudnessLufs: -19.5, truePeakDb: -2.2 });
  db.upsertTrackAnalysis('kate', { bpm: 121, loudnessLufs: -22.26, peakDb: -6.05 });
  const r = row('kate');
  assert.equal(r.loudness_lufs, -19.5);
  assert.equal(r.peak_db, -2.2);
  // ...while a track still on window figures takes the new window measurement.
  seed('plain', -15, -1);
  db.upsertTrackAnalysis('plain', { bpm: 100, loudnessLufs: -14, peakDb: -0.5 });
  assert.equal(row('plain').loudness_lufs, -14);
});

test('--re-analyze clears window figures and keeps whole-file ones', () => {
  db.clearAnalysis();
  assert.equal(row('kate').loudness_lufs, -19.5, 'whole-file loudness survives the clear');
  assert.equal(row('kate').peak_db, -2.2);
  assert.equal(row('plain').loudness_lufs, null, 'window loudness is cleared as before');
  assert.equal(row('plain').peak_db, null);
});

test('the scope goes quietest-reading first, then never-measured, and skips stamped tracks', () => {
  db.getDb()!.prepare('DELETE FROM tracks').run();
  seed('loud', -9.5, -0.3);
  seed('quiet', -31.6, -12.7);
  seed('mid', -17.9, -4.8);
  seed('none', null, null);
  seed('done', -20, -5);
  db.recordWholeFileLoudness('done', { loudnessLufs: -14, truePeakDb: -0.5 });
  assert.deepEqual(db.needsWholeFileLoudnessIds(), ['quiet', 'mid', 'loud', 'none']);
  assert.deepEqual(db.needsWholeFileLoudnessIds(2), ['quiet', 'mid']);
});

test('MAX_LOUDNESS_ATTEMPTS consecutive failures drop a track; a success resets', () => {
  for (let i = 0; i < db.MAX_LOUDNESS_ATTEMPTS; i++) db.recordWholeFileLoudnessFailure('none');
  assert.ok(!db.needsWholeFileLoudnessIds().includes('none'));
  assert.equal(db.wholeFileLoudnessCounts().givenUp, 1);
  db.recordWholeFileLoudnessFailure('mid');
  db.recordWholeFileLoudness('mid', { loudnessLufs: -17.1, truePeakDb: -4.0 });
  assert.equal(row('mid').loudness_attempts, null);
  assert.equal(db.clearWholeFileLoudnessFailures(), 1);
  assert.ok(db.needsWholeFileLoudnessIds().includes('none'));
});

test('id adoption carries the stamp with the figures it describes', () => {
  const plan = db.columnPlan();
  assert.deepEqual(plan.unclassified, []);
  const analysis = plan.grouped.find(g => g.anchor === 'analysis_version');
  assert.ok(analysis?.cols.includes('loudness_version'));
  assert.ok(analysis?.cols.includes('loudness_attempts'));
  assert.ok(analysis?.cols.includes('loudness_lufs'));
});

test('the pass measures the backlog through the sidecar, quietest first', async () => {
  db.getDb()!.prepare('DELETE FROM tracks').run();
  seed('q1', -31.6, -12.7);
  seed('q2', -22.3, -6.1);
  seed('q3', -12, -0.5);
  answers.set('q1', { loudness_lufs: -12.0, true_peak_db: -0.3, sample_peak_db: -0.5 });
  answers.set('q2', { loudness_lufs: -19.5, true_peak_db: -2.2, sample_peak_db: -2.4 });
  answers.set('q3', 'fail');
  requested.length = 0;
  assert.equal(await analyzer.resolveBackend(), 'sidecar');
  const stats = await analyze.runWholeFileLoudnessPass();
  assert.deepEqual(requested, ['q1', 'q2', 'q3']);
  assert.deepEqual(stats, { measured: 2, failed: 1, scope: 3, pending: 1 });
  assert.deepEqual(row('q1'), { loudness_lufs: -12, peak_db: -0.3, loudness_version: db.WHOLE_FILE_LOUDNESS_VERSION, loudness_attempts: null });
  assert.equal(row('q3').loudness_attempts, 1, 'an isolated failure counts against its file');
  assert.equal(row('q3').loudness_lufs, -12, 'and leaves the window figures in place');
});

test('a run of failures is an outage: the batch stops and nobody is stamped', async () => {
  db.getDb()!.prepare('DELETE FROM tracks').run();
  const ids = Array.from({ length: 10 }, (_, i) => `o${i}`);
  ids.forEach((id, i) => { seed(id, -30 + i, -10); answers.set(id, 'fail'); });
  requested.length = 0;
  const stats = await analyze.runWholeFileLoudnessPass();
  assert.ok(stats && stats.measured === 0);
  assert.ok(requested.length < ids.length, 'the batch stopped early');
  for (const id of ids) assert.equal(row(id).loudness_attempts, null, `${id} not stamped`);
});

test('a sidecar that does not advertise the pass is never sent it', async () => {
  advertise = false;
  analyzer._resetBackendCacheForTests();
  await analyzer.resolveBackend();
  requested.length = 0;
  assert.equal(await analyze.runWholeFileLoudnessPass(), undefined);
  assert.deepEqual(requested, []);
  advertise = true;
  analyzer._resetBackendCacheForTests();
  await analyzer.resolveBackend();
});

test('off unless ANALYZE_WHOLE_FILE_LOUDNESS is set', async () => {
  // config is read once at import; the switch is read through it.
  const { config } = await import('../src/config.js');
  const was = config.analyzer.wholeFileLoudness;
  (config.analyzer as { wholeFileLoudness: string }).wholeFileLoudness = '';
  try {
    requested.length = 0;
    assert.equal(analyze.wholeFileLoudnessWanted(), false);
    assert.equal(await analyze.runWholeFileLoudnessPass(), undefined);
    assert.deepEqual(requested, []);
  } finally {
    (config.analyzer as { wholeFileLoudness: string }).wholeFileLoudness = was;
  }
});
