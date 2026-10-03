// Tests for the facet planner (music/acoustics-plan.ts) and the facet mode of
// the analysis pass (runAnalysisPass({ plan })).
//
// The contracts pinned here:
//   - `--where needs` selects exactly what facetNeedsIds() selects, so the
//     planner and the status table agree on "has work";
//   - the other --where kinds select by stored state (missing, unmeasurable
//     with a reason filter, failed INCLUDING exhausted retries, outdated, all);
//   - a facet the analyzer definitively can't produce is skipped and counted,
//     never planned into a guaranteed no-op;
//   - each work item becomes the right flat-protocol flags: CLAP alone takes
//     the embedding-only fast path, and a track that didn't ask for CLAP or
//     vocals gets them explicitly OFF;
//   - with a plan, the pass analyses exactly the planned tracks with those
//     flags (checked against a fake sidecar), and the facet table records the
//     result;
//   - a facet the worker reports failed is 'failed' in the table even where
//     the columns alone read 'unmeasurable', so it is retried up to the
//     attempt limit and no longer re-planned by `--where unmeasurable`.
//
// Real better-sqlite3 DB in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `tsx scripts/acoustics-plan.test.ts` (npm test).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.stack || err}`); });
}

// ---- fake analyzer sidecar + Navidrome stream ------------------------------
const requests: Array<Record<string, unknown>> = [];
let clapCapable = true;
// Facet protocol on the stub (off = an analyzer that predates it).
let facetsCapable = false;
// Per-facet answers the stub gives for a facet request (default: ok).
let facetAnswers: Record<string, Record<string, unknown>> = {};
let streamHits = 0;
function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'],
      analyze_audio_capable: clapCapable, analyze_vocal_capable: false,
      ...(facetsCapable ? { analyze_facets_capable: true, analyze_ranged_tail_capable: true } : {}),
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      res.setHeader('Content-Type', 'application/json');
      const vec = Array.from({ length: 512 }, () => 0.01);
      if (Array.isArray(r.facets)) {
        const ok: Record<string, unknown> = {
          head: { bpm: 99, key: 'Dm', intro_ms: 500, confidence: 0.8 },
          loudness: { loudness_lufs: -12, peak_db: -2 },
          tail: { tail_silence_ms: 2500, tail_start_ms: 211_500, outro: { startMs: 200_000, ending: 'fade' } },
          clap: { audio_embedding: vec },
        };
        const facets: Record<string, unknown> = {};
        for (const f of r.facets) facets[f] = facetAnswers[f] ?? { status: 'ok', data: ok[f] };
        res.end(JSON.stringify({
          ok: true, facets,
          source: r.ranged
            ? { kind: 'ranged', duration_s: 214, complete: true, size: 30_000_000, bytes_read: 3_000_000 }
            : { kind: 'path', duration_s: 214, complete: r.complete ?? null },
        }));
        return;
      }
      if (r.embedding_only) {
        res.end(JSON.stringify({ ok: true, audio_embedding: vec }));
        return;
      }
      res.end(JSON.stringify({
        ok: true, bpm: 120, key: 'Am', intro_ms: 1000, confidence: 0.9,
        loudness_lufs: -10, peak_db: -1,
        tail_silence_ms: 1500, tail_start_ms: 200_000,
        outro: { startMs: 190_000, ending: 'fade' },
        ...(r.embed ? { audio_embedding: vec } : {}),
      }));
    });
    return;
  }
  // Navidrome stream / anything else: a few bytes of "audio".
  if (req.url?.startsWith('/rest/stream')) streamHits += 1;
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

async function main() {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-plan-'));
  process.env.STATE_DIR = stateDir;
  process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
  process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
  process.env.NAVIDROME_USER = 'u';
  process.env.NAVIDROME_PASS = 'p';
  delete process.env.ANALYZE_AUDIO_EMBEDDING;
  delete process.env.ANALYZE_VOCAL_ACTIVITY;

  const db = await import('../src/music/library-db.js');
  const P = await import('../src/music/acoustics-plan.js');
  const { runAnalysisPass } = await import('../src/music/analyze.js');
  const analyzer = await import('../src/music/analyzer.js');
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  const sql = () => db.requireDb();

  // a: fully analysed with CLAP · b: capped (tail unmeasurable) · c: never
  // analysed · d: failed 3× (exhausted) · e: analysed, no CLAP, old tail version
  for (const id of ['a', 'b', 'c', 'd', 'e']) db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 220 });
  const clap = new Float32Array(512).fill(0.2);
  db.upsertTrackAnalysis('a', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, tailSilenceMs: 0, outro: { startMs: 1, ending: 'cold' } as never, source: 'full' });
  db.upsertTrackAudioVector('a', clap);
  db.upsertTrackAnalysis('b', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, source: 'capped' });
  db.upsertTrackAudioVector('b', clap);
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('d', 'not audio');
  db.upsertTrackAnalysis('e', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, tailSilenceMs: 0, outro: { startMs: 1, ending: 'cold' } as never, source: 'full' });
  sql().prepare(`UPDATE track_facet_status SET version = 0 WHERE track_id = 'e' AND facet = 'tail'`).run();

  const ids = db.allTrackIdsOrdered();
  const plan = (facets: string, where?: string, caps = { clap: true as boolean | null, demucs: false as boolean | null }, limit?: number) => {
    const f = P.parseFacets(facets);
    return P.planAcoustics({ ids, facets: f, where: P.parseWhere(where), state: db.loadFacetState(f), capabilities: caps, limit });
  };
  const planned = (p: ReturnType<typeof plan>) => p.items.map((i) => i.id);

  console.log('selection:');

  await test('--where needs agrees with facetNeedsIds for every facet', () => {
    for (const f of db.FACETS) {
      const p = plan(f, undefined, { clap: true, demucs: true });
      assert.deepEqual(planned(p), db.facetNeedsIds(f), f);
    }
  });

  await test('unmeasurable:<reason> picks the capped tail only', () => {
    assert.deepEqual(planned(plan('tail', 'unmeasurable:capped')), ['b']);
    assert.deepEqual(planned(plan('tail', 'unmeasurable:nothing-like-this')), []);
  });

  await test('failed includes tracks past the retry limit (explicit retry)', () => {
    assert.deepEqual(planned(plan('head', 'failed')), ['d']);
    assert.ok(!planned(plan('head')).includes('d'), 'needs must still exclude the exhausted track');
  });

  await test('missing / outdated / all', () => {
    assert.deepEqual(planned(plan('clap', 'missing')), ['c', 'e']);
    assert.deepEqual(planned(plan('tail', 'outdated')), ['e']);
    assert.deepEqual(planned(plan('head', 'all')), ['a', 'b', 'c', 'd', 'e']);
  });

  await test('a facet the analyzer cannot produce is skipped and counted', () => {
    const p = plan('vocal', 'missing', { clap: true, demucs: false });
    assert.equal(p.items.length, 0);
    // d already has a (failed) vocal row, so 4 tracks are missing it.
    assert.equal(p.byFacet[0].skipped['no-demucs'], 4);
    const unknown = plan('vocal', 'missing', { clap: true, demucs: null });
    assert.equal(unknown.items.length, 4, 'unknown capability still plans');
    assert.ok(unknown.warnings.some((w) => w.includes('Demucs capability unknown')));
  });

  await test('--limit caps tracks and reports what it left out', () => {
    const p = plan('head', 'all', undefined, 2);
    assert.deepEqual(planned(p), ['a', 'b']);
    assert.equal(p.byFacet[0].skipped.limit, 3);
  });

  await test('parsers reject unknown names', () => {
    assert.throws(() => P.parseFacets('tail,bogus'), /unknown facet "bogus"/);
    assert.throws(() => P.parseWhere('sometimes'), /unknown --where/);
    assert.throws(() => P.parseWhere('failed:capped'), /only applies to --where unmeasurable/);
    assert.deepEqual(P.parseFacets('CLAP, tail'), ['tail', 'clap']);
  });

  console.log('request flags:');

  await test('clap alone takes the embedding-only fast path', () => {
    assert.deepEqual(P.requestFor(['clap']), { embeddingOnly: true, clap: true, vocal: false, stems: false });
  });

  await test('tail alone is a full analysis with CLAP and vocals off', () => {
    assert.deepEqual(P.requestFor(['tail']), { embeddingOnly: false, clap: false, vocal: false, stems: false });
  });

  await test('the dry-run summary names ride-along facets', () => {
    const lines = P.formatPlan(plan('tail', 'unmeasurable'));
    assert.ok(lines.some((l) => l.includes('also recomputes head, loudness')), lines.join('\n'));
  });

  console.log('runAnalysisPass with a plan:');

  await test('analyses exactly the planned tracks, with per-track flags', async () => {
    analyzer._resetBackendCacheForTests();
    requests.length = 0;
    const p = P.planAcoustics({
      ids, facets: ['clap'], where: { kind: 'missing' }, state: db.loadFacetState(['clap']),
      capabilities: { clap: true, demucs: false },
    });
    const stats = await runAnalysisPass({ plan: p });
    assert.equal(stats.scope, 2);
    assert.equal(stats.analyzed, 2);
    assert.equal(requests.length, 2);
    for (const r of requests) {
      assert.equal(r.embedding_only, true, JSON.stringify(r));
      assert.equal(r.embed, true);
    }
    // c and e now have a vector; d is past its retry limit, so nothing is due.
    assert.deepEqual(db.facetNeedsIds('clap'), []);
    for (const id of ['c', 'e']) {
      const r = sql().prepare(`SELECT status, source FROM track_facet_status WHERE track_id = ? AND facet = 'clap'`).get(id) as { status: string; source: string };
      assert.deepEqual(r, { status: 'ok', source: 'analyzer' }, id);
    }
  });

  await test('a tail redo turns CLAP and vocals explicitly off and fixes the tail facet', async () => {
    requests.length = 0;
    const p = plan('tail', 'unmeasurable:capped');
    const stats = await runAnalysisPass({ plan: p });
    assert.equal(stats.analyzed, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].embed, false);
    assert.equal(requests[0].vocal, false);
    assert.ok(!requests[0].embedding_only);
    const tail = sql().prepare(`SELECT status FROM track_facet_status WHERE track_id = 'b' AND facet = 'tail'`).get() as { status: string };
    assert.equal(tail.status, 'ok');
  });

  await test('an empty plan analyses nothing', async () => {
    requests.length = 0;
    const stats = await runAnalysisPass({ plan: plan('tail', 'unmeasurable:capped') });
    assert.equal(stats.scope, 0);
    assert.equal(requests.length, 0);
  });

  console.log('facet protocol:');
  facetsCapable = true;
  analyzer._resetBackendCacheForTests();
  const facetRow = (id: string, f: string) =>
    sql().prepare('SELECT status, reason, source, version FROM track_facet_status WHERE track_id = ? AND facet = ?').get(id, f) as
      { status: string; reason: string | null; source: string; version: number } | undefined;

  await test('a tail-only plan sends a ranged tail request and writes only the tail', async () => {
    db.upsertTrackMeta('t1', { title: 't1', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t1', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
    requests.length = 0;
    streamHits = 0;
    const p = P.planAcoustics({ ids: ['t1'], facets: ['tail'], where: { kind: 'unmeasurable' },
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false } });
    const stats = await runAnalysisPass({ plan: p });
    assert.equal(stats.analyzed, 1);
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.deepEqual(r.facets, ['tail']);
    assert.equal(r.ranged, true);
    assert.ok(typeof r.url === 'string' && !('path' in r), 'a ranged read goes by url, no staged copy');
    assert.equal(streamHits, 0, 'no capped download for a ranged track');
    const t = db.getTrack('t1')!;
    assert.equal(t.tailStartMs, 211_500);
    assert.equal(t.bpm, 128, 'a tail-only answer must not rewrite BPM');
    assert.deepEqual(facetRow('t1', 'tail'), { status: 'ok', reason: null, source: 'ranged', version: db.FACET_VERSIONS.tail });
  });

  await test('an unmeasurable tail keeps the columns and records the worker\'s reason', async () => {
    db.upsertTrackMeta('t2', { title: 't2', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t2', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
    facetAnswers = { tail: { status: 'unmeasurable', reason: 'silent-tail-window' } };
    const p = P.planAcoustics({ ids: ['t2'], facets: ['tail'], where: { kind: 'unmeasurable' },
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false } });
    await runAnalysisPass({ plan: p });
    facetAnswers = {};
    assert.equal(db.getTrack('t2')!.tailStartMs ?? null, null);
    const row = facetRow('t2', 'tail')!;
    assert.equal(row.status, 'unmeasurable');
    assert.equal(row.reason, 'silent-tail-window');
  });

  await test('a facet that fails counts one attempt; the others are written', async () => {
    db.upsertTrackMeta('t3', { title: 't3', artist: 'A', album: 'B', duration: 214 });
    facetAnswers = { clap: { status: 'failed', reason: 'decode error' } };
    requests.length = 0;
    const p = P.planAcoustics({ ids: ['t3'], facets: ['head', 'clap'], where: { kind: 'all' },
      state: db.loadFacetState(['head', 'clap']), capabilities: { clap: true, demucs: false } });
    const stats = await runAnalysisPass({ plan: p });
    facetAnswers = {};
    assert.equal(stats.analyzed, 1);
    assert.ok(!requests[0].ranged, 'head + clap never asks for a ranged read');
    assert.equal(db.getTrack('t3')!.bpm, 99);
    assert.equal(facetRow('t3', 'head')!.status, 'ok');
    assert.equal(facetRow('t3', 'clap')!.status, 'failed');
    assert.equal(db.analysisFailures().find((f) => f.id === 't3')?.attempts, 1);
  });

  await test('when every facet fails, the track fails like a flat analysis', async () => {
    db.upsertTrackMeta('t4', { title: 't4', artist: 'A', album: 'B', duration: 214 });
    facetAnswers = { head: { status: 'failed', reason: 'boom' } };
    const p = P.planAcoustics({ ids: ['t4'], facets: ['head'], where: { kind: 'all' },
      state: db.loadFacetState(['head']), capabilities: { clap: true, demucs: false } });
    const stats = await runAnalysisPass({ plan: p });
    facetAnswers = {};
    assert.equal(stats.failed, 1);
    assert.equal(stats.analyzed, 0);
  });

  await test('a tail that fails is recorded as failed, so an unmeasurable re-run stops planning it', async () => {
    // Production, 3 Oct: a ranged tail failed ("window starts before the
    // fetched tail") on an analysed track. The row stayed 'unmeasurable /
    // tail-not-measured', so facets-cli showed no failure and every
    // `--where unmeasurable:tail-not-measured` run planned it again.
    db.upsertTrackMeta('t5', { title: 't5', artist: 'A', album: 'B', duration: 106 });
    db.upsertTrackAnalysis('t5', { bpm: 90, musicalKey: 'F', loudnessLufs: -30 });
    const where = { kind: 'unmeasurable' as const, reason: 'tail-not-measured' };
    const tailPlan = () => P.planAcoustics({ ids: ['t5'], facets: ['tail'], where,
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false } });
    assert.equal(facetRow('t5', 'tail')!.reason, 'tail-not-measured');
    assert.equal(tailPlan().items.length, 1);
    facetAnswers = { tail: { status: 'failed', reason: 'window starts before the fetched tail' } };
    const stats = await runAnalysisPass({ plan: tailPlan() });
    facetAnswers = {};
    assert.equal(stats.failed, 1);
    const row = facetRow('t5', 'tail')!;
    assert.equal(row.status, 'failed');
    assert.match(row.reason ?? '', /^tail: window starts before the fetched tail/);
    assert.equal(facetRow('t5', 'head')!.status, 'ok', 'the head stays measured');
    assert.equal(tailPlan().items.length, 0, 'unmeasurable:<reason> no longer matches a failed tail');
    assert.ok(db.facetNeedsIds('tail').includes('t5'), 'needs retries it while under the attempt limit');
    for (let i = 1; i < db.FACET_MAX_ATTEMPTS; i++) db.recordAnalysisFailure('t5', 'tail: window starts before the fetched tail');
    assert.ok(!db.facetNeedsIds('tail').includes('t5'), 'and stops at the limit');
    // The admin "clear failures" puts the track back where it was.
    db.clearAnalysisFailures('t5');
    assert.deepEqual(
      { status: facetRow('t5', 'tail')!.status, reason: facetRow('t5', 'tail')!.reason },
      { status: 'unmeasurable', reason: 'tail-not-measured' },
    );
    assert.equal(tailPlan().items.length, 1);
  });

  await test('a flat failure on an analysed track leaves its unmeasured tail unmeasurable', async () => {
    db.upsertTrackMeta('t6', { title: 't6', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t6', { bpm: 90, musicalKey: 'F', loudnessLufs: -9, source: 'capped' });
    db.recordAnalysisFailure('t6', 'read ECONNRESET');
    assert.equal(facetRow('t6', 'tail')!.status, 'unmeasurable');
    assert.equal(facetRow('t6', 'clap')!.status, 'failed');
  });

  await test('the facet table stays consistent with the columns through facet writes', async () => {
    const { checkFacets } = await import('../src/music/facet-check.js');
    const r = checkFacets();
    assert.equal(r.driftCount, 0, JSON.stringify(r.drift));
    assert.equal(r.orphans, 0);
  });

  analyzer.shutdown();
  db.close();
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`✗ acoustics-plan.test.ts: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('✓ acoustics-plan.test.ts passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
