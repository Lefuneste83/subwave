// Tests for the tail facet placed from the stored edges (tail v2), and its
// loudness curve (tail v3).
//
// The tail window used to be the file's last ANALYZE_OUTRO_SECONDS, which on a
// track ending in dead air is partly or wholly silence: production showed the
// silence turning cold endings into fades (of the tracks with more than 3 s of
// trailing silence, 13,901 read 'fade' and 48 'cold'). The controller now
// sends where the music stops (decoded duration minus the trailing silence,
// both from the whole-file `edges` facet) and the analyzer ends the window
// there.
//
// The contracts pinned here:
//   - the tail facet is at v3 (a placed window whose outro carries the
//     short-term loudness curve the audible-end cut of a fade reads); a tail's
//     version is read off the columns: `tail_version` (3 = placed with the
//     curve, 2 = placed without it — an analyzer without pyloudnorm), else 2
//     when the stored edges show at most TAIL_PLACEMENT_TOLERANCE_MS of
//     trailing silence (the old window then held the same music), else 1.
//     Everything below v3 is due again for `--facets tail`;
//   - an unmeasurable tail without edges stays one version below, so it is
//     retried once edges can place it;
//   - measuring edges promotes an existing tail the tolerance covers, live
//     (not only on a whole-table re-derive), so the remaining edges backfill
//     does not plan every short-silence track for a tail re-read;
//   - a planned tail request carries `tail_window` (+ the stream URL for a
//     capped copy) when edges are stored, and only an answer marked
//     `tail_window: "edges"` stamps v2/v3 (an older analyzer ignores the
//     field), v3 only when the answer carries a valid curve;
//   - a flat analysis and a --re-analyze clear never overwrite a placed tail
//     with an end-of-file one (the loudness v2 rule);
//   - schema step 31 adds `tail_version`, safely re-run, and the derivation
//     stamp moved so production's table re-derives once.
//
// Real better-sqlite3 in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `npm test -- tail-placement`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const requests: Array<Record<string, unknown>> = [];
let placedAnswer = true;
// The placed window cannot be read (a damaged file even ffmpeg gives up on).
let placedMiss = false;
// The analyzer measures the tail's loudness curve (it has pyloudnorm).
let curveAnswer = true;
const CURVE = { startMs: 190_000, stepMs: 500, lufs: [-120, -150, -300] };

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_capable: true,
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      const tw = r.tail_window as { end_ms: number; duration_ms: number } | undefined;
      if (!r.facets) {
        // A regular (flat) analysis: the whole flat answer.
        const end = tw && placedAnswer ? tw.end_ms : 214_000;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true, bpm: 120, key: 'Am', intro_ms: 0, confidence: 0.9, loudness_lufs: -10, peak_db: -1,
          outro: { startMs: end - 5000, ending: 'cold', bpm: 120, beats: [end - 1000], ...(curveAnswer ? { loudnessCurve: CURVE } : {}) },
          ...(tw && placedAnswer ? { tail_window: 'edges', tail_silence_ms: tw.duration_ms - tw.end_ms, tail_start_ms: tw.end_ms }
            : { tail_silence_ms: 300, tail_start_ms: 213_700 }),
        }));
        return;
      }
      const facets: Record<string, unknown> = {};
      // The whole-file lane (a regular run's backfill): edges place the tail.
      if (r.facets.includes('edges')) facets.edges = { status: 'ok', data: { edge_lead_ms: 0, edge_tail_ms: 20_000, decoded_duration_ms: 214_000 } };
      if (r.facets.includes('loudness')) facets.loudness = { status: 'ok', data: { loudness_lufs: -12, peak_db: -1, sample_peak_db: -1.2, lra_lu: 6, loudness_version: 2 } };
      if (r.facets.includes('tail') && tw && placedMiss) {
        facets.tail = { status: 'unmeasurable', reason: 'tail-not-reached' };
      } else if (r.facets.includes('tail')) {
        const end = tw && placedAnswer ? tw.end_ms : 214_000;
        facets.tail = {
          status: 'ok',
          data: {
            ...(tw && placedAnswer ? { tail_window: 'edges', tail_silence_ms: tw.duration_ms - tw.end_ms, tail_start_ms: tw.end_ms }
              : { tail_silence_ms: 400, tail_start_ms: 213_600 }),
            outro: { startMs: end - 6000, ending: 'cold', bpm: 120, beats: [end - 2000, end - 1500], ...(curveAnswer ? { loudnessCurve: CURVE } : {}) },
          },
        };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, facets, source: { kind: 'path', duration_s: 214, complete: r.complete ?? null } }));
    });
    return;
  }
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = createTempDir(join(tmpdir(), 'subwave-tail-placement-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;

const db = await import('../src/music/library-db.js');
const P = await import('../src/music/acoustics-plan.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const analyzer = await import('../src/music/analyzer.js');
const { checkFacets } = await import('../src/music/facet-check.js');
const { config } = await import('../src/config.js');
const { MAX_ANALYSIS_FAILURES } = await import('../src/music/analyze-capability.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
await analyzer.isAvailable();

after(async () => {
  analyzer.shutdown();
  server.close();
  await removeTempDir(stateDir);
});

const sql = (q: string) => db.requireDb().prepare(q);
type Row = { status: string; version: number; reason: string | null };
const tailRow = (id: string) =>
  sql('SELECT status, version, reason FROM track_facet_status WHERE track_id = ? AND facet = ?').get(id, 'tail') as Row | undefined;
const tailVersionCol = (id: string) => (sql('SELECT tail_version AS v FROM tracks WHERE id = ?').get(id) as { v: number | null }).v;
const consistent = () => {
  const r = checkFacets();
  assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans }));
};
const OUTRO = { startMs: 200_000, ending: 'fade' as const, lufs: null, bpm: null, beats: null, bars: null };
const track = (id: string) => {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
};
// A v3 answer carries the curve (that is what makes it v3: placedTailVersion).
const writeTail = (id: string, version?: number) =>
  db.writeFacetResults(id, { source: 'full', tail: {
    outro: version === 3 ? { ...OUTRO, loudnessCurve: CURVE } : OUTRO,
    tailSilenceMs: 500, tailStartMs: 213_500, ...(version ? { version } : {}) } });
const writeEdges = (id: string, tailMs: number) =>
  db.writeFacetResults(id, { source: 'url', edges: { leadMs: 0, tailMs, durationMs: 214_000 } });
const plan = (ids: string[]) => {
  const f = P.parseFacets('tail');
  return P.planAcoustics({
    ids, facets: f, where: { kind: 'needs' }, state: db.loadFacetState(f),
    capabilities: { clap: false, demucs: false, tailVocal: false, wholeFile: true },
  });
};

test('the tail facet is at v3, and step 31 adds tail_version', () => {
  assert.equal(db.FACET_VERSIONS.tail, 3);
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 31);
  assert.ok((sql(`SELECT name FROM pragma_table_info('tracks') WHERE name = 'tail_version'`).all()).length === 1);
});

test('step 31 re-runs safely on a database that already has the column', async () => {
  db.requireDb().pragma('user_version = 30');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 31);
});

test('a tail the analyzer placed with its curve is stamped v3 and settles', () => {
  track('placed');
  writeEdges('placed', 12_000);
  writeTail('placed', 3);
  assert.equal(tailVersionCol('placed'), 3);
  assert.deepEqual([tailRow('placed')?.status, tailRow('placed')?.version], ['ok', 3]);
  assert.ok(!db.facetNeedsIds('tail').includes('placed'));
  consistent();
});

test('a placed tail without the curve (v2) is re-planned for v3', () => {
  track('placed2');
  writeEdges('placed2', 12_000);
  writeTail('placed2', 2);
  assert.equal(tailVersionCol('placed2'), 2);
  assert.deepEqual([tailRow('placed2')?.status, tailRow('placed2')?.version], ['ok', 2]);
  assert.ok(db.facetNeedsIds('tail').includes('placed2'));
  // …and a v2 row a whole-table re-derive meets stays v2, i.e. due.
  db.resyncAllFacets(db.requireDb());
  assert.equal(tailRow('placed2')?.version, 2);
  assert.ok(plan(['placed2']).items.some((i) => i.id === 'placed2'), 'planned by --facets tail');
  consistent();
});

test('placedTailVersion: v3 only with a valid curve', () => {
  assert.equal(db.placedTailVersion({ loudnessCurve: CURVE }), 3);
  assert.equal(db.placedTailVersion({ loudnessCurve: { ...CURVE, lufs: [] } }), 3, 'measured, too short for a point');
  assert.equal(db.placedTailVersion({}), 2, 'no curve: an analyzer without pyloudnorm');
  assert.equal(db.placedTailVersion({ loudnessCurve: { ...CURVE, lufs: [1, 'x'] } }), 2, 'malformed');
  assert.equal(db.placedTailVersion(null), 3, 'no outro: nothing to carry a curve');
});

test('an end-of-file tail is v1 unless the edges show the window held the same music (v2, still due for v3)', () => {
  for (const [id, silence, version] of [['short', 2_500, 2], ['edge', 3_000, 2], ['long', 3_001, 1]] as const) {
    track(id);
    writeEdges(id, silence);
    writeTail(id);
    assert.equal(tailVersionCol(id), null, id);
    assert.deepEqual([tailRow(id)?.status, tailRow(id)?.version], ['ok', version], id);
  }
  track('noedges');
  writeTail('noedges');
  assert.deepEqual([tailRow('noedges')?.status, tailRow('noedges')?.version], ['ok', 1]);
  // Below v3 all of them are due: the tolerance only spares the v1 → v2 step,
  // the end-of-file window has no curve.
  const due = db.facetNeedsIds('tail');
  for (const id of ['long', 'noedges', 'short', 'edge']) assert.ok(due.includes(id), `${id}: ${due.join(',')}`);
  consistent();
});

test('an end-of-file answer replaces a placed tail, and drops its stamp', () => {
  track('replaced');
  writeEdges('replaced', 9_000);
  writeTail('replaced', 3);
  writeTail('replaced');
  assert.equal(tailVersionCol('replaced'), null);
  assert.equal(tailRow('replaced')?.version, 1);
});

test('tail vocal ranges are carried only onto the same window', () => {
  track('tv');
  writeEdges('tv', 20_000);
  db.writeFacetResults('tv', { source: 'full', tail: {
    outro: { ...OUTRO, vocalRanges: [{ startMs: 205_000, endMs: 208_000 }] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  // An end-of-file re-measure without vocals keeps them (same window)...
  writeTail('tv');
  assert.deepEqual(db.getTrack('tv')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 208_000 }]);
  // ...a newly placed window does not: they were measured on other audio.
  writeTail('tv', 3);
  assert.equal(db.getTrack('tv')!.outro?.vocalRanges ?? null, null);
  consistent();
});

test('measuring edges promotes a tail the tolerance covers, live', () => {
  track('later-short');
  writeTail('later-short');
  assert.equal(tailRow('later-short')?.version, 1);
  writeEdges('later-short', 800);
  assert.deepEqual([tailRow('later-short')?.status, tailRow('later-short')?.version], ['ok', 2]);
  track('later-long');
  writeTail('later-long');
  writeEdges('later-long', 15_000);
  assert.equal(tailRow('later-long')?.version, 1);
  consistent();
});

test('an unmeasurable tail without edges stays due until edges can place it', () => {
  track('capped');
  db.writeFacetResults('capped', { source: 'capped', tail: { unmeasurable: 'capped-download' } });
  assert.deepEqual([tailRow('capped')?.status, tailRow('capped')?.version], ['unmeasurable', 2]);
  assert.ok(db.facetNeedsIds('tail').includes('capped'));
  // Edges arriving do not settle it: the tail was never measured.
  writeEdges('capped', 500);
  assert.equal(tailRow('capped')?.version, 2);
  assert.ok(db.facetNeedsIds('tail').includes('capped'));
  // With edges, an unmeasurable answer is the placed attempt's: it settles.
  track('capped2');
  writeEdges('capped2', 500);
  db.writeFacetResults('capped2', { source: 'capped', tail: { unmeasurable: 'tail-not-reached' } });
  assert.deepEqual([tailRow('capped2')?.status, tailRow('capped2')?.version], ['unmeasurable', 3]);
  consistent();
});

test('a capped-download tail stays due even with edges: the window was not placed', () => {
  // The regular analysis pass reads the end-of-file window off the capped
  // download; with edges stored it must not settle the tail as if placed.
  track('cap-edged');
  writeEdges('cap-edged', 500);
  db.writeFacetResults('cap-edged', { source: 'capped', tail: { unmeasurable: 'capped-download' } });
  assert.deepEqual([tailRow('cap-edged')?.status, tailRow('cap-edged')?.version], ['unmeasurable', 2]);
  assert.ok(db.facetNeedsIds('tail').includes('cap-edged'));
  // Same through the flat path, which explains a missing tail the same way.
  track('cap-flat');
  writeEdges('cap-flat', 500);
  db.upsertTrackAnalysis('cap-flat', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'capped' });
  assert.deepEqual([tailRow('cap-flat')?.status, tailRow('cap-flat')?.version], ['unmeasurable', 2]);
  // A complete copy whose end-of-file window gave nothing: unplaced, so due.
  track('flat-none');
  writeEdges('flat-none', 500);
  db.upsertTrackAnalysis('flat-none', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  assert.deepEqual([tailRow('flat-none')?.status, tailRow('flat-none')?.version], ['unmeasurable', 2]);
  // A stored row settled that way by an earlier controller is re-opened on the
  // next re-derive.
  sql(`UPDATE track_facet_status SET version = 3 WHERE track_id = 'cap-edged' AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.equal(tailRow('cap-edged')?.version, 2);
  consistent();
});

test('an unplaced unmeasurable answer stays due; a placed one settles', () => {
  track('unpl');
  writeEdges('unpl', 500);
  db.writeFacetResults('unpl', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('unpl')?.status, tailRow('unpl')?.version], ['unmeasurable', 2]);
  db.writeFacetResults('unpl', { source: 'full', tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('unpl')?.status, tailRow('unpl')?.version], ['unmeasurable', 3]);
  // A later write that does not re-measure the tail keeps the settled version.
  db.upsertTrackAudioVector('unpl', Array.from({ length: db.AUDIO_EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)));
  assert.equal(tailRow('unpl')?.version, 3);
  consistent();
});

test('a silent file settles its tail: there is no music end to place a window at', () => {
  const silent = (id: string) =>
    db.writeFacetResults(id, { source: 'url', unmeasurable: { edges: 'silent-file' } });
  // Edges first, then an end-of-file tail answer (ok, unplaced).
  track('sil-ok');
  silent('sil-ok');
  writeTail('sil-ok');
  assert.deepEqual([tailRow('sil-ok')?.status, tailRow('sil-ok')?.version], ['ok', 3]);
  // An unmeasurable answer from the unplaced window settles too.
  track('sil-um');
  silent('sil-um');
  db.writeFacetResults('sil-um', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('sil-um')?.status, tailRow('sil-um')?.version], ['unmeasurable', 3]);
  // Tail stored first, then the edges scan finds the file silent: promoted.
  track('sil-late');
  writeTail('sil-late');
  assert.equal(tailRow('sil-late')?.version, 1);
  silent('sil-late');
  assert.equal(tailRow('sil-late')?.version, 3);
  track('sil-late-um');
  db.writeFacetResults('sil-late-um', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.equal(tailRow('sil-late-um')?.version, 2);
  silent('sil-late-um');
  assert.equal(tailRow('sil-late-um')?.version, 3);
  // None of them is planned again.
  const due = db.facetNeedsIds('tail');
  for (const id of ['sil-ok', 'sil-um', 'sil-late', 'sil-late-um']) assert.ok(!due.includes(id), id);
  // Rows an earlier derivation left at v1 are settled by the next re-derive.
  sql(`UPDATE track_facet_status SET version = 1 WHERE track_id IN ('sil-ok', 'sil-um') AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.deepEqual([tailRow('sil-ok')?.version, tailRow('sil-um')?.version], [3, 3]);
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 5);
  consistent();
  // A later edges scan that finds music brings the normal rule back.
  writeEdges('sil-ok', 9_000);
  assert.equal(tailRow('sil-ok')?.version, 1);
  consistent();
});

test('a whole-table re-derive applies the same rule to existing rows', () => {
  track('legacy');
  writeEdges('legacy', 1_000);
  writeTail('legacy');
  sql(`UPDATE track_facet_status SET version = 1 WHERE track_id = 'legacy' AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.equal(tailRow('legacy')?.version, 2);
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 5);
  consistent();
});

test('a flat analysis and a --re-analyze clear keep a placed tail', () => {
  track('kept');
  writeEdges('kept', 9_000);
  writeTail('kept', 3);
  db.upsertTrackAnalysis('kept', {
    bpm: 101, musicalKey: 'D', loudnessLufs: -9, peakDb: -1, source: 'full',
    outro: { ...OUTRO, startMs: 1 }, tailSilenceMs: 9_100, tailStartMs: 204_900,
  });
  let t = db.getTrack('kept')!;
  assert.equal(t.outro?.startMs, 200_000);
  assert.equal(t.tailStartMs, 213_500);
  assert.equal(tailVersionCol('kept'), 3);
  db.clearAnalysis();
  t = db.getTrack('kept')!;
  assert.equal(t.outro?.startMs, 200_000);
  assert.deepEqual(t.outro?.loudnessCurve, CURVE, 'the curve is kept with its tail');
  assert.equal(tailVersionCol('kept'), 3);
  assert.equal(tailRow('kept')?.version, 3);
  // An end-of-file tail is the analysis being redone: cleared.
  assert.equal(db.getTrack('long')!.outro, null);
  consistent();
});

test('a planned tail sends the placement from the stored edges and stores v3 with the curve', async () => {
  track('p1');
  writeEdges('p1', 20_000);
  requests.length = 0;
  await runAnalysisPass({ plan: plan(['p1']) });
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual(r.tail_window, { end_ms: 194_000, duration_ms: 214_000 }, JSON.stringify(r));
  assert.ok(typeof r.stream_url === 'string' && String(r.stream_url).includes('/rest/'), JSON.stringify(r));
  const t = db.getTrack('p1')!;
  assert.equal(t.outro?.startMs, 188_000);
  assert.equal(t.tailStartMs, 194_000);
  assert.equal(t.tailSilenceMs, 20_000);
  assert.deepEqual(t.outro?.loudnessCurve, CURVE, 'the curve survives the answer → outro_json → read');
  assert.equal(tailVersionCol('p1'), 3);
  assert.deepEqual([tailRow('p1')?.status, tailRow('p1')?.version], ['ok', 3]);
});

test('a placed answer without the curve (no pyloudnorm) stores v2 and stays due', async () => {
  track('p1b');
  writeEdges('p1b', 20_000);
  curveAnswer = false;
  try {
    await runAnalysisPass({ plan: plan(['p1b']) });
  } finally {
    curveAnswer = true;
  }
  assert.equal(db.getTrack('p1b')!.outro?.loudnessCurve, undefined);
  assert.equal(tailVersionCol('p1b'), 2);
  assert.deepEqual([tailRow('p1b')?.status, tailRow('p1b')?.version], ['ok', 2]);
  assert.ok(db.facetNeedsIds('tail').includes('p1b'));
});

test('without edges, or from an analyzer that ignores the placement, the tail stays v1', async () => {
  track('p2');
  requests.length = 0;
  await runAnalysisPass({ plan: plan(['p2']) });
  assert.ok(!('tail_window' in requests[0]), JSON.stringify(requests[0]));
  assert.equal(tailRow('p2')?.version, 1);
  track('p3');
  writeEdges('p3', 20_000);
  placedAnswer = false;
  try {
    await runAnalysisPass({ plan: plan(['p3']) });
  } finally {
    placedAnswer = true;
  }
  assert.equal(tailVersionCol('p3'), null);
  assert.equal(tailRow('p3')?.version, 1);
});

test('a placed window that cannot be read over a measured tail is a failure, not a silent ok', async () => {
  track('miss');
  writeTail('miss');
  writeEdges('miss', 9_000);
  const before = db.getTrack('miss')!;
  assert.equal(tailRow('miss')?.version, 1);
  placedMiss = true;
  try {
    for (let i = 1; i <= MAX_ANALYSIS_FAILURES; i++) {
      assert.ok(db.facetNeedsIds('tail').includes('miss'), `planned on attempt ${i}`);
      const stats = await runAnalysisPass({ plan: plan(['miss']) });
      assert.deepEqual([stats.analyzed, stats.failed], [0, 1], JSON.stringify(stats));
      const row = sql('SELECT analyze_fail_count AS n, analyze_error AS e FROM tracks WHERE id = ?').get('miss') as
        { n: number; e: string };
      assert.equal(row.n, i);
      assert.match(row.e, /tail: .*tail-not-reached/);
    }
  } finally {
    placedMiss = false;
  }
  // The stored tail is kept as it was, and the planner stops asking.
  const after_ = db.getTrack('miss')!;
  assert.deepEqual([after_.outro, after_.tailSilenceMs], [before.outro, before.tailSilenceMs]);
  assert.equal(tailRow('miss')?.status, 'ok');
  assert.ok(!db.facetNeedsIds('tail').includes('miss'));
  consistent();
});

test('a placed window that cannot be read with no tail stored is recorded as unmeasurable', async () => {
  track('miss2');
  writeEdges('miss2', 9_000);
  placedMiss = true;
  try {
    const stats = await runAnalysisPass({ plan: plan(['miss2']) });
    assert.deepEqual([stats.analyzed, stats.failed], [1, 0], JSON.stringify(stats));
  } finally {
    placedMiss = false;
  }
  assert.deepEqual([tailRow('miss2')?.status, tailRow('miss2')?.reason, tailRow('miss2')?.version],
    ['unmeasurable', 'tail-not-reached', 3]);
  consistent();
});

test('a flat analysis that placed its tail replaces the stored one and stamps its version', () => {
  track('flatv2');
  writeEdges('flatv2', 9_000);
  writeTail('flatv2', 3);
  db.upsertTrackAnalysis('flatv2', {
    bpm: 101, musicalKey: 'D', loudnessLufs: -9, peakDb: -1, source: 'full',
    outro: { ...OUTRO, startMs: 199_000 }, tailSilenceMs: 9_000, tailStartMs: 205_000, tailVersion: 2,
  });
  assert.equal(db.getTrack('flatv2')!.outro?.startMs, 199_000);
  assert.equal(db.getTrack('flatv2')!.tailStartMs, 205_000);
  assert.equal(tailVersionCol('flatv2'), 2);
  assert.equal(tailRow('flatv2')?.version, 2);
  db.upsertTrackAnalysis('flatv2', {
    bpm: 101, musicalKey: 'D', loudnessLufs: -9, peakDb: -1, source: 'full',
    outro: { ...OUTRO, startMs: 198_000, loudnessCurve: CURVE }, tailSilenceMs: 9_000, tailStartMs: 205_000, tailVersion: 3,
  });
  assert.equal(tailVersionCol('flatv2'), 3);
  assert.equal(tailRow('flatv2')?.version, 3);
  consistent();
});

test('the regular analysis pass sends the placement too, and stores v3', async () => {
  db.upsertTrackMeta('flat1', { title: 'flat1', artist: 'A', album: 'B', duration: 214 });
  writeEdges('flat1', 20_000);
  requests.length = 0;
  await runAnalysisPass({ vocalBackfill: false, audioBackfill: false });
  const r = requests.find((q) => !q.facets && JSON.stringify(q).includes('flat1'));
  assert.ok(r, JSON.stringify(requests));
  assert.deepEqual(r.tail_window, { end_ms: 194_000, duration_ms: 214_000 }, JSON.stringify(r));
  assert.ok(typeof r.stream_url === 'string' || typeof r.url === 'string', JSON.stringify(r));
  const t = db.getTrack('flat1')!;
  assert.equal(t.outro?.startMs, 189_000);
  assert.equal(t.tailStartMs, 194_000);
  assert.deepEqual(t.outro?.loudnessCurve, CURVE);
  assert.equal(tailVersionCol('flat1'), 3);
  assert.deepEqual([tailRow('flat1')?.status, tailRow('flat1')?.version], ['ok', 3]);
});

test('the planner explains where the tail window comes from', () => {
  track('w1');
  const p = plan(['w1']);
  const note = p.warnings.find((w) => w.startsWith('tail:'));
  assert.ok(note && /edges/.test(note) && !/byte-capped/.test(note), p.warnings.join('\n'));
});

test('a regular run measures the edges first, so a NEW track\'s tail is placed on its one read', async () => {
  // A track the walk just added: no analysis, no edges. With the whole-file
  // backfill on, the run must measure its edges BEFORE the regular pass reads
  // its tail; the other way round the tail is read off the end of the file,
  // stored one version below, and nothing in the run goes back to it.
  db.upsertTrackMeta('fresh1', { title: 'fresh1', artist: 'A', album: 'B', duration: 214 });
  assert.equal(db.getTrack('fresh1')?.decodedDurationMs ?? null, null);
  // An already-analysed track that only lacks the whole-file facets: the rest
  // of the backfill, which must not hold the new track's analysis back.
  track('old1');
  (config.analyzer as { wholeFile: boolean }).wholeFile = true;
  try {
    requests.length = 0;
    await runAnalysisPass({ vocalBackfill: false, audioBackfill: false });
  } finally {
    (config.analyzer as { wholeFile: boolean }).wholeFile = false;
  }
  const mine = (q: Record<string, unknown>) => JSON.stringify(q).includes('fresh1');
  const edgesAt = requests.findIndex((q) => mine(q) && Array.isArray(q.facets) && (q.facets as string[]).includes('edges'));
  const flatAt = requests.findIndex((q) => mine(q) && !q.facets);
  assert.ok(edgesAt >= 0 && flatAt >= 0, JSON.stringify(requests));
  assert.ok(edgesAt < flatAt, `edges asked at ${edgesAt}, the tail read at ${flatAt}`);
  const oldEdgesAt = requests.findIndex((q) => JSON.stringify(q).includes('old1') && Array.isArray(q.facets) && (q.facets as string[]).includes('edges'));
  assert.ok(oldEdgesAt > flatAt, `the library backfill (old1 at ${oldEdgesAt}) runs after the regular pass (${flatAt})`);
  assert.deepEqual(requests[flatAt].tail_window, { end_ms: 194_000, duration_ms: 214_000 });
  assert.equal(tailVersionCol('fresh1'), 3);
  assert.deepEqual([tailRow('fresh1')?.status, tailRow('fresh1')?.version], ['ok', 3]);
  consistent();
});
