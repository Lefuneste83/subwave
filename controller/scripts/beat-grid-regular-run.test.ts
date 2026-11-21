// A regular run (the GUI's Start tagging / Analyze audio, as a facet plan)
// measuring the opt-in beat grid and structure while a show has Hot Mix on
// (analyze.ts runPlannedRegularPass, the rule in beat-grid-run-policy.ts).
//
// Pinned here:
//   - with Hot Mix on and an analyzer that reports both facets, a new track is
//     analysed, then its grid measured, then its structure measured on that
//     same grid (the structure step is planned after the grid step wrote it),
//     and a second run asks for neither again;
//   - without Hot Mix the run sends no grid or structure request at all, and
//     its stats carry no beatGrid figures (byte-identical to before);
//   - an analyzer that says it cannot, or has not said, gets nothing planned
//     for that facet, and the run says so once; the structure still runs on a
//     grid already stored when only the grid is missing;
//   - a grid the analyzer fails on is stamped failed and counted, and the
//     run still completes.
// Real better-sqlite3 in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `npm test -- beat-grid-regular-run`.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const requests: Array<Record<string, unknown>> = [];
// What /health reports for the two facets (undefined: the key is absent).
let gridCapable: boolean | undefined = true;
let structureCapable: boolean | undefined = true;
// The grid answer fails at the transport level (a sidecar 500).
let gridCrash = false;

const GOOD_GRID = {
  grid_version: 1, engine: 'beat_this', model: 'final0', bpm: 124.0, beats_per_bar: 4,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  coverage: 0.98, residual_ms: 5.2, downbeat_agreement: 0.84, main_share: 0.99,
  beats_detected: 712, decoded_ms: 340_000,
};
const N = 20;
const GOOD_STRUCTURE = {
  structure_version: 1,
  runs: [[480, 1_935_484, N]],
  kick: [...Array(4).fill(-10), ...Array(N - 4).fill(0)],
  kicks: Array(N).fill(4),
  bass: [...Array(4).fill(-20), ...Array(N - 4).fill(-2)],
  mid: [...Array(4).fill(-8), ...Array(N - 4).fill(-1)],
  high: Array(N).fill(-3),
  level: Array(N).fill(-1),
  melody: Array(N).fill(6.5),
  decoded_ms: 340_000,
};

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_capable: true, analyze_tail_loudness_curve_capable: true,
      ...(gridCapable === undefined ? {} : { analyze_grid_capable: gridCapable }),
      ...(structureCapable === undefined ? {} : { analyze_structure_capable: structureCapable }),
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      const fs: string[] = r.facets ?? [];
      if (gridCrash && fs.includes('grid')) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      const tw = r.tail_window as { end_ms: number; duration_ms: number } | undefined;
      const facets: Record<string, unknown> = {};
      if (fs.includes('head')) facets.head = { status: 'ok', data: { bpm: 120, key: 'Am', intro_ms: 0, confidence: 0.9 } };
      if (fs.includes('edges')) facets.edges = { status: 'ok', data: { edge_lead_ms: 0, edge_tail_ms: 20_000, decoded_duration_ms: 340_000 } };
      if (fs.includes('loudness')) facets.loudness = { status: 'ok', data: { loudness_lufs: -12, peak_db: -1, sample_peak_db: -1.2, lra_lu: 6, loudness_version: 2 } };
      if (fs.includes('tail')) {
        const end = tw ? tw.end_ms : 340_000;
        facets.tail = {
          status: 'ok',
          data: {
            ...(tw ? { tail_window: 'edges', tail_silence_ms: tw.duration_ms - tw.end_ms, tail_start_ms: tw.end_ms } : { tail_silence_ms: 400, tail_start_ms: 339_600 }),
            outro: { startMs: end - 6000, ending: 'cold', bpm: 120, beats: [end - 2000, end - 1500], loudnessCurve: { startMs: end - 6000, stepMs: 500, lufs: [-12, -14] } },
          },
        };
      }
      if (fs.includes('grid')) facets.grid = { status: 'ok', data: GOOD_GRID };
      if (fs.includes('structure')) facets.structure = { status: 'ok', data: GOOD_STRUCTURE };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, facets, source: { kind: 'path', duration_s: 340, complete: r.complete ?? null } }));
    });
    return;
  }
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = createTempDir(join(tmpdir(), 'subwave-beat-grid-run-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;

const db = await import('../src/music/library-db.js');
const analyzer = await import('../src/music/analyzer.js');
const settings = await import('../src/settings.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const { config } = await import('../src/config.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

before(async () => {
  await settings.load();
});

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
  await removeTempDir(stateDir);
});

async function hotMix(on: boolean) {
  await settings.update({
    shows: on ? [{ id: 's_mix', name: 'Night Set', personaId: settings.get().personas[0].id, hotMix: { enabled: true } }] : [],
  } as never);
}

const fresh = (id: string) => db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 340 } as never);
const of = (id: string) => (q: Record<string, unknown>) => JSON.stringify(q).includes(`"${id}"`) || JSON.stringify(q).includes(`id=${id}`);
const asks = (q: Record<string, unknown>, f: string) => Array.isArray(q.facets) && (q.facets as string[]).includes(f);
const at = (id: string, f: string) => requests.findIndex((q) => of(id)(q) && asks(q, f));

// A regular run with the whole-file lane on (the planned regular run), the
// console lines it printed captured.
async function regularRun(): Promise<{ stats: Awaited<ReturnType<typeof runAnalysisPass>>; lines: string[] }> {
  await analyzer.refreshCapabilities();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  (config.analyzer as { wholeFile: boolean }).wholeFile = true;
  requests.length = 0;
  try {
    return { stats: await runAnalysisPass({ vocalBackfill: false, audioBackfill: false }), lines };
  } finally {
    (config.analyzer as { wholeFile: boolean }).wholeFile = false;
    console.log = log;
  }
}

test('without Hot Mix a regular run sends no grid or structure request, and reports no beat-grid figures', async () => {
  await hotMix(false);
  gridCapable = true;
  structureCapable = true;
  fresh('off1');
  const { stats, lines } = await regularRun();
  assert.ok(at('off1', 'head') >= 0, 'the track was analysed');
  assert.ok(!requests.some((q) => asks(q, 'grid') || asks(q, 'structure')), JSON.stringify(requests));
  assert.ok(!('beatGrid' in stats), JSON.stringify(stats));
  assert.ok(!lines.some((l) => /beat grid|structure|Hot Mix/i.test(l)), lines.join('\n'));
  assert.equal(db.getGrid('off1'), null);
});

test('with Hot Mix on, a new track is analysed, then gridded, then its structure measured on that grid', async () => {
  await hotMix(true);
  gridCapable = true;
  structureCapable = true;
  fresh('znew1');
  const { stats, lines } = await regularRun();
  const head = at('znew1', 'head');
  const grid = at('znew1', 'grid');
  const structure = at('znew1', 'structure');
  assert.ok(head >= 0 && grid > head && structure > grid, `head ${head}, grid ${grid}, structure ${structure}`);
  assert.deepEqual(requests[grid].facets, ['grid'], 'the grid is its own step');
  assert.deepEqual(requests[structure].facets, ['structure']);
  assert.deepEqual((requests[structure].structure_grid as { segments: unknown }).segments, GOOD_GRID.segments, 'measured on the grid written this run');
  assert.equal(db.getGrid('znew1')?.status, 'ok');
  assert.equal(db.getStructure('znew1')?.status, 'ok');
  assert.equal(db.getStructure('znew1')?.gridAt, db.getGrid('znew1')?.measuredAt);
  // The off-Hot-Mix track from the test before is due too, and taken.
  assert.ok(at('off1', 'grid') >= 0, 'the backlog is measured too');
  assert.ok(at('znew1', 'grid') < at('off1', 'grid'), 'the run\'s new tracks go first');
  assert.ok(lines.some((l) => /regular run: grid \d+ planned of \d+ due/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /regular run: structure \d+ planned of \d+ due/.test(l)), lines.join('\n'));
  assert.deepEqual(stats.beatGrid, { analyzed: 4, failed: 0, scope: 4 }, JSON.stringify(stats));

  // Converged: a second run asks for neither again.
  const again = await regularRun();
  assert.ok(!requests.some((q) => asks(q, 'grid') || asks(q, 'structure')), JSON.stringify(requests));
  assert.ok(!('beatGrid' in again.stats), 'nothing measured: no figures');
});

test('an analyzer without the grid gets nothing gridded, says so, and still measures stored grids', async () => {
  await hotMix(true);
  gridCapable = false;
  structureCapable = true;
  fresh('nogrid1');
  // A track with a grid stored and no structure yet.
  fresh('stored1');
  db.writeGridResult('stored1', { grid: analyzer.parseGridAnswer(GOOD_GRID)! });
  const { lines } = await regularRun();
  assert.equal(at('nogrid1', 'grid'), -1);
  assert.ok(!requests.some((q) => asks(q, 'grid')), JSON.stringify(requests));
  assert.ok(at('stored1', 'structure') >= 0, 'the structure runs on the stored grid');
  assert.equal(db.getStructure('stored1')?.status, 'ok');
  const notices = lines.filter((l) => l.startsWith('[analyze] A show has Hot Mix on'));
  assert.equal(notices.length, 1, lines.join('\n'));
  assert.match(notices[0], /cannot measure the beat grid/);
});

test('an analyzer that has not said is asked for neither, and the run says so once', async () => {
  await hotMix(true);
  gridCapable = undefined;
  structureCapable = undefined;
  fresh('unknown1');
  const { stats, lines } = await regularRun();
  assert.ok(at('unknown1', 'head') >= 0);
  assert.ok(!requests.some((q) => asks(q, 'grid') || asks(q, 'structure')), JSON.stringify(requests));
  assert.ok(!('beatGrid' in stats));
  const notices = lines.filter((l) => l.startsWith('[analyze] A show has Hot Mix on'));
  assert.equal(notices.length, 1, lines.join('\n'));
  assert.match(notices[0], /has not said/);
});

test('a grid the analyzer fails on is counted as a failure, never fatal to the run', async () => {
  await hotMix(true);
  gridCapable = true;
  structureCapable = true;
  gridCrash = true;
  try {
    fresh('crash1');
    const { stats } = await regularRun();
    assert.ok(at('crash1', 'head') >= 0, 'analysed');
    assert.ok(at('crash1', 'grid') >= 0, 'asked');
    assert.equal(db.getGrid('crash1')?.status ?? 'failed', 'failed');
    assert.equal(stats.available, true);
    assert.ok((stats.beatGrid?.failed ?? 0) >= 1, JSON.stringify(stats));
  } finally {
    gridCrash = false;
  }
});
