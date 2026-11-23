// DJ Hot Mix through the real pick paths, with only HTTP stubbed: the Agentic
// discovery tools (and so the Track Shortlist, which runs its searches through
// them), the stateless pool behind them, a steer, the request route, and the
// saved show across a cold load. The show is a real takeover, so what reaches
// each path is what settings.resolveActiveShow says.
//
// The rules pinned here: off is unchanged; the tools are HARD on the window; the
// pool never starves, it takes the nearest tempos; every tempo is the Hot Mix
// resolver's (the applied beat grid's, never the quick head estimate nor a
// grid held on a metrical disagreement), and the model reads only that; a show with a curve anchors on the curve's tempo, not on the
// track before; requests close by default and the toggle opens them.
// Run: `npm test -- hot-mix-pick-paths`.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { chatCompletionResponse } from './test-utils/llm.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-hot-mix-picks-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://hot-mix-picks.invalid';
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const blocklist = await import('../src/music/blocklist.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');
const { livePickerScope } = await import('../src/broadcast/dj-agent.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
const { steeredShow } = await import('../src/music/steer.js');
const { hotMixOf } = await import('../src/music/hot-mix-policy.js');
const { router: requestRouter } = await import('../src/routes/request.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { requestsClosure } = await import('../src/util/requests-open.js');
const { predecessorContext } = await import('../src/broadcast/dj-agent/pick-context.js');
const { hotMixTempoNote } = await import('../src/music/show-candidates.js');

type Song = { id: string; title: string; artist: string; duration: number; genre: string; genres: Array<{ name: string }>; bpm?: number };
let seq = 0;
const song = (id: string, bpm?: number): Song => ({
  id, title: id, artist: `Act ${++seq}`, duration: 300, genre: 'House', genres: [{ name: 'House' }],
  ...(bpm === undefined ? {} : { bpm }),
});

// A library row for `id`: the head analysis's quick tempo (`stored`), and a
// whole-track grid at `grid` BPM, steady over `steady` of the track. A grid
// with coverage 0.97 passes the write gate and is applied over the stored
// tempo; with `coverage` under 0.8 it is measured but held.
function measure(id: string, { stored, grid, steady = 0.95, coverage = 0.97 }: { stored: number; grid?: number; steady?: number; coverage?: number }) {
  db.upsertTrackMeta(id, { title: id, artist: `Act ${id}`, album: 'Album', duration: 300 } as never);
  db.upsertTrackAnalysis(id, { bpm: stored, musicalKey: '8A', loudnessLufs: -9, source: 'full' } as never);
  if (grid == null) return;
  const decodedMs = 300_000;
  const periodUs = 60_000_000 / grid;
  const beats = Math.round((steady * decodedMs * 1000) / periodUs) + 1;
  const slowUs = periodUs * 1.1;
  db.writeGridResult(id, {
    grid: {
      version: 1, engine: 'beat_this', model: 'final0', bpm: grid, beatsPerBar: 4,
      segments: [
        { anchorMs: 0, periodUs, beats, downbeatMs: 0 },
        { anchorMs: (beats * periodUs) / 1000, periodUs: slowUs, beats: Math.max(2, Math.round(((1 - steady) * decodedMs * 1000) / slowUs)), downbeatMs: null },
      ],
      coverage, residualMs: 5, downbeatAgreement: 0.84, downbeatHalfbar: null, downbeatDropDb: null, downbeatPhase: null,
      mainShare: steady, decodedMs,
    },
  });
}

// The fixtures' library rows, written once the library is open (before()).
const seeds: Array<() => void> = [];

let random: Song[] = [];
let offered: Array<Array<{ id: string }>> = [];

const realFetch = globalThis.fetch;
const app = express();
app.use(express.json());
app.use(requestRouter);
app.use(publicRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: { provider: 'openai-compatible', model: 'hot-mix-test', baseUrl: 'http://hot-mix-model.invalid/v1', apiKey: 'test' },
  } as never);
  await blocklist.load();
  await library.load();
  for (const seed of seeds) seed();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    if (raw.startsWith(base)) return realFetch(input, init);
    const url = new URL(raw);
    if (url.hostname === 'hot-mix-model.invalid') {
      // The pool's model call: record what it was offered and take the first.
      const body = JSON.parse(String(init?.body));
      let payload: any = null;
      try { payload = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]); } catch { /* not a pool pick */ }
      if (!Array.isArray(payload?.candidates)) return new Response('offline', { status: 503 });
      offered.push(payload.candidates);
      return chatCompletionResponse({
        id: 'c', created: 0, model: 'hot-mix-test',
        message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 't', type: 'function',
            function: { name: body.tools[0].function.name, arguments: JSON.stringify({ id: payload.candidates[0].id, reason: 'Fixture' }) },
          }],
        },
      });
    }
    // Anything else (an opened request resolving in the background) is refused,
    // not asserted: it runs after its test has already answered.
    if (url.hostname !== 'hot-mix-picks.invalid') return new Response('offline', { status: 503 });
    const endpoint = url.pathname.split('/').at(-1);
    const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: random } }
      : endpoint === 'getSongsByGenre' ? { songsByGenre: { song: random } }
        : endpoint === 'getGenres' ? { genres: { genre: [{ value: 'House', songCount: 10 }] } }
          : {};
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  library.shutdown();
  await removeTempDir(stateRoot);
});

beforeEach(() => {
  random = [];
  offered = [];
  clearPoolCache();
  clearPlaylistCache();
});

async function onAir(show: Record<string, unknown>) {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_mix', name: 'Future Frequencies', personaId: settings.get().personas[0].id, ...show }],
    scheduleOverride: { showId: 's_mix', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  return settings.resolveActiveShow();
}

// The track on air, measured with an applied grid at `onAirBpm` (null: no
// library row at all, its tempo unknown).
function stubQueue(onAirBpm: number | null = 124) {
  const q = Object.create(queue);
  const id = onAirBpm == null ? 'on-air-unknown' : `on-air-${onAirBpm}`;
  if (onAirBpm != null) measure(id, { stored: onAirBpm, grid: onAirBpm });
  q.current = { track: { id, title: 'On Air', artist: 'On Air Act', ...(onAirBpm == null ? {} : { bpm: onAirBpm }) } };
  q.upcoming = [];
  q.history = [];
  q._recentPlays = [];
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => { logs.push(line); };
  return { q, logs };
}

const MIX = { hotMix: { enabled: true, maxStepPct: 6 } };
const IN = song('in-window', 128);
const HALF = song('half-time', 62);
const FAR = song('far', 140);
const UNKNOWN = song('unknown');
// A quick head estimate inside the window and no grid: unknown to Hot Mix.
const ESTIMATE_ONLY = song('estimate-only', 126);
seeds.push(() => {
  measure('in-window', { stored: 128, grid: 128 });
  measure('half-time', { stored: 62, grid: 62 });
  measure('far', { stored: 140, grid: 140 });
  measure('estimate-only', { stored: 126 });
});

// ─── Agentic discovery tools ────────────────────────────────────────────────

test('agentic: the live scope measures the window from the track on air, and every tool is hard on it', async () => {
  await onAir(MIX);
  random = [IN, HALF, FAR, UNKNOWN, ESTIMATE_ONLY];
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q);
  assert.deepEqual(scope.tempoWindow, { anchorBpm: 124, maxStepPct: 6, targetBpm: null, anchoredOn: 'predecessor' });
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  assert.deepEqual([...seen.keys()].sort(), ['half-time', 'in-window']);
});

test('agentic: an explicit pick anchor, not the track on air, is what the step is measured from', async () => {
  await onAir(MIX);
  measure('queued', { stored: 99.38, grid: 140 });
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q, { pickAnchor: { id: 'queued', title: 'Queued', artist: 'Q', bpm: 99.38 } });
  assert.equal(scope.tempoWindow?.anchorBpm, 140);
});

test('agentic: without a curve, an anchor known only by its quick estimate cannot anchor a step', async () => {
  await onAir(MIX);
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q, { pickAnchor: { id: 'estimate-only', title: 'E', artist: 'E', bpm: 126 } });
  assert.equal(scope.tempoWindow, null);
});

test('agentic: a show without Hot Mix has no window and sees every track', async () => {
  await onAir({});
  random = [IN, FAR, UNKNOWN];
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q);
  assert.equal(scope.tempoWindow, null);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  assert.deepEqual([...seen.keys()].sort(), ['far', 'in-window', 'unknown']);
});

test('agentic: an anchor with no tempo and no curve leaves the pick unconstrained', async () => {
  await onAir(MIX);
  const { q } = stubQueue(null);
  const { scope } = await livePickerScope(q);
  assert.equal(scope.tempoWindow, null);
});

test('agentic: a tool left with nothing names the tempo window', async () => {
  await onAir(MIX);
  random = [FAR];
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q);
  const { tools } = buildPickerTools(scope) as any;
  const answer = await tools.randomSongs.execute({}, {});
  assert.deepEqual(answer.tracks ?? answer, []);
  if (answer.note) assert.match(answer.note, /Hot Mix tempo window/);
});

// ─── The stateless pool ─────────────────────────────────────────────────────

const pool = (q: any, activeShow: unknown) =>
  pickViaPool(q, { dominantMood: null, activeShow, time: { period: 'night' } }, null, null, {});

test('pool: only tracks inside the window are offered, and the booth log names it', async () => {
  const show = await onAir(MIX);
  random = [IN, FAR, UNKNOWN, ESTIMATE_ONLY];
  const { q, logs } = stubQueue(124);
  const picked = await pool(q, show);
  assert.ok(picked);
  assert.deepEqual(offered[0].map((c) => c.id), ['in-window']);
  assert.ok(logs.some((l) => /Hot Mix "Future Frequencies": tempo window 117-131 BPM around 124/.test(l)), logs.join('\n'));
});

test('pool: with nothing inside the window it never starves, it takes the nearest tempo', async () => {
  const show = await onAir(MIX);
  measure('very-far', { stored: 170, grid: 170 });
  measure('nearest', { stored: 140, grid: 140 });
  random = [song('very-far', 170), song('nearest', 140), UNKNOWN, ESTIMATE_ONLY];
  const { q, logs } = stubQueue(124);
  const picked = await pool(q, show);
  assert.ok(picked);
  // 140 is the nearest (13 %); 170 reads as 85, 31 % away, past one step
  // beyond it, so only the nearest reaches the model.
  assert.deepEqual(offered[0].map((c) => c.id), ['nearest']);
  assert.ok(logs.some((l) => /nothing inside .* taking the nearest tempos/.test(l)), logs.join('\n'));
});

// ─── A show with a curve: the set sits at its target ────────────────────────

// The reproduction: a Hot Mix show with a curve opens after a show that ended
// at 96 BPM. Its picks must sit on the curve's 122, not crawl up from 96, and a
// track must pass on its applied grid's tempo, never on the quick head estimate
// nor on a grid the write decision held.
const CURVED = { hotMix: { enabled: true, maxStepPct: 3, curve: [{ at: 0, bpm: 122 }, { at: 50, bpm: 124 }, { at: 75, bpm: 123 }, { at: 90, bpm: 122 }] } };
// Stored 99.4 by the head estimate, 125 on a steady grid held by its coverage:
// a metrical disagreement, so neither tempo is trusted and the track is out.
const GRID_HELD = song('grid-held', 99.38);
// Stored 123.05 by the head estimate, 124 on a steady grid under the same
// coverage: a refinement of the head's tempo, so the grid is applied and 124
// is the tempo Hot Mix reads.
const REFINED = song('refined', 123.05);
// Stored 123.05 by the head estimate, never gridded.
const NO_GRID = song('no-grid', 123.05);
// Stored 99.4, its grid 125 but steady on only 40 % of the track.
const UNSTEADY = song('unsteady', 99.38);
// Within one step of the predecessor, far from the curve.
const NEAR_PREDECESSOR = song('near-predecessor', 98);
seeds.push(() => {
  measure('grid-held', { stored: 99.38, grid: 125, coverage: 0.786, steady: 0.917 });
  measure('refined', { stored: 123.05, grid: 124, coverage: 0.786, steady: 0.917 });
  measure('no-grid', { stored: 123.05 });
  measure('unsteady', { stored: 99.38, grid: 125, coverage: 0.786, steady: 0.4 });
  measure('near-predecessor', { stored: 98, grid: 98 });
  measure('beyond-curve', { stored: 131, grid: 131 });
});

test('the fixture: the refinement is applied by the write path, the disagreement held', () => {
  assert.equal(db.getGrid('refined')?.applied, 1);
  assert.equal(db.getGrid('grid-held')?.applied, 0);
  assert.equal(db.getGrid('unsteady')?.applied, 0);
});

test('curve: the agent\'s window is the step around the curve\'s tempo, whatever the previous show ended on', async () => {
  await onAir(CURVED);
  random = [GRID_HELD, REFINED, NO_GRID, UNSTEADY, NEAR_PREDECESSOR, UNKNOWN];
  const { q } = stubQueue(96);
  const { scope } = await livePickerScope(q);
  const w = scope.tempoWindow!;
  assert.equal(w.anchoredOn, 'curve');
  assert.equal(Math.round(w.anchorBpm), 122);
  assert.equal(w.targetBpm, w.anchorBpm);
  assert.equal(w.maxStepPct, 3);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  // The grid held on a metrical disagreement (125 against a stored 99.4) is
  // out: only the applied grid's track is in, at the grid's own tempo.
  assert.deepEqual([...seen.keys()], ['refined']);
  assert.equal(seen.get('refined').bpm, 124);
});

test('curve: the pool offers the same window and shows the model the resolved tempos', async () => {
  const show = await onAir(CURVED);
  random = [GRID_HELD, REFINED, NO_GRID, UNSTEADY, NEAR_PREDECESSOR, UNKNOWN];
  const { q, logs } = stubQueue(96);
  assert.ok(await pool(q, show));
  assert.deepEqual(offered[0].map((c: any) => [c.id, c.bpm]), [['refined', 124]]);
  assert.ok(logs.some((l) => /tempo window 118-126 BPM around 122 \(±3%, the curve's tempo\)/.test(l)), logs.join('\n'));
});

test('curve: with nothing inside, the pool keeps the known tempos nearest the target', async () => {
  const show = await onAir(CURVED);
  // 98 sits a step from the predecessor (96) but 20 % from the curve; 131 is 7 %
  // from it; the stored-only, unsteady and held tracks have no tempo Hot Mix
  // trusts (the held grid's 125 would sit inside the window).
  random = [NEAR_PREDECESSOR, GRID_HELD, song('beyond-curve', 131), NO_GRID, UNSTEADY];
  const { q, logs } = stubQueue(96);
  await pool(q, show);
  assert.deepEqual(offered[0].map((c: any) => [c.id, c.bpm]), [['beyond-curve', 131]]);
  assert.ok(logs.some((l) => /nothing inside 118-126 BPM around 122 .* taking the nearest tempos/.test(l)), logs.join('\n'));
});

test('curve: with no known tempo at all the pool still plays, and shows the model no tempo', async () => {
  const show = await onAir(CURVED);
  random = [GRID_HELD, NO_GRID, UNSTEADY];
  const { q } = stubQueue(96);
  const picked = await pool(q, show);
  assert.ok(picked);
  assert.deepEqual(offered[0].map((c: any) => c.id).sort(), ['grid-held', 'no-grid', 'unsteady']);
  assert.ok(offered[0].every((c: any) => c.bpm === undefined), JSON.stringify(offered[0]));
});

test('a show without Hot Mix is untouched: every track offered, each with its stored tempo', async () => {
  const show = await onAir({});
  random = [GRID_HELD, NO_GRID, UNSTEADY, UNKNOWN];
  const { q } = stubQueue(96);
  await pool(q, show);
  const bpm = Object.fromEntries(offered[0].map((c: any) => [c.id, c.bpm]));
  assert.deepEqual(bpm, { 'grid-held': 99.38, 'no-grid': 123.05, 'unsteady': 99.38, unknown: undefined });
});

test('the predecessor the model reads carries the resolved tempo in a Hot Mix pick, the stored one otherwise', () => {
  const anchor = { id: 'refined', title: 'R', artist: 'A', bpm: 123.05 };
  assert.equal(predecessorContext(anchor, { hotMix: true })?.bpm, 124);
  // A grid held on a metrical disagreement: no tempo shown in a Hot Mix pick,
  // the stored one otherwise.
  const held = { id: 'grid-held', title: 'G', artist: 'A', bpm: 99.38 };
  assert.equal(predecessorContext(held, { hotMix: true })?.bpm, undefined);
  assert.equal(predecessorContext(held)?.bpm, 99.38);
  // No tempo Hot Mix trusts: none shown (the key still is).
  const stored = predecessorContext({ id: 'no-grid', title: 'N', artist: 'A', bpm: 123.05 }, { hotMix: true });
  assert.equal(stored?.bpm, undefined);
  assert.equal(stored?.key, '8A');
});

test('the show editor counts what Hot Mix can judge, and what reaches the curve', () => {
  const rows = ['grid-held', 'refined', 'no-grid', 'unsteady', 'near-predecessor', 'beyond-curve'].map((id) => ({ id }));
  assert.equal(hotMixTempoNote(CURVED, rows),
    'Hot Mix judges tempo on the applied beat grid only: 3 of 6 library tracks have a tempo it trusts, and the rest are left out of its picks. 1 of them sit within ±3% of the curve (122-124 BPM).');
  assert.match(hotMixTempoNote(MIX, rows)!, /3 of 6 library tracks have a tempo it trusts, and the rest are left out of its picks\.$/);
  assert.equal(hotMixTempoNote({}, rows), null);
});

// ─── A steer ────────────────────────────────────────────────────────────────

test('a playlist steer is the operator\'s own choice: the window stands aside', async () => {
  const show = await onAir(MIX);
  assert.ok(hotMixOf(show));
  assert.equal(hotMixOf(steeredShow(show, { playlistId: 'pl' } as never)), null);
  // A prompt-only steer changes no field, Hot Mix included.
  assert.ok(hotMixOf(steeredShow(show, { prompt: 'warmer' } as never)));
});

// ─── Requests ───────────────────────────────────────────────────────────────

const ask = () => realFetch(`${base}/request`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Some Song by Some Act', name: 'Listener' }),
});

test('requests: a Hot Mix show refuses them by default, naming the show', async () => {
  await onAir(MIX);
  const res = await ask();
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as any).message, /closed during Future Frequencies/);
});

test('requests: the toggle opens them, and a show without Hot Mix is untouched', async () => {
  for (const show of [{ hotMix: { enabled: true, closeRequests: false } }, {}]) {
    await onAir(show);
    const res = await ask();
    // Past this gate the route goes on to its own checks; whatever it answers,
    // it is not the Hot Mix refusal.
    const body: any = await res.json().catch(() => ({}));
    assert.doesNotMatch(String(body.message ?? ''), /continuous mix/);
  }
});

// ─── Telling the listener first ─────────────────────────────────────────────

const stateRequests = async () => ((await (await realFetch(`${base}/state`)).json()) as any).requests;

test('/state publishes the closure before anyone sends, with the same line the route refuses with', async () => {
  await onAir(MIX);
  assert.deepEqual(await stateRequests(), { open: false, message: "Requests are closed during Future Frequencies: it's a continuous mix." });
  await onAir({ hotMix: { enabled: true, closeRequests: false } });
  assert.deepEqual(await stateRequests(), { open: true });
  await onAir({});
  assert.deepEqual(await stateRequests(), { open: true });
});

test('the station switch closes them too, and outranks a show that would open them', async () => {
  await onAir({});
  await settings.update({ requests: { enabled: false } } as never);
  try {
    assert.deepEqual(await stateRequests(), { open: false, message: 'Requests are temporarily closed.' });
    const res = await ask();
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).message, 'Requests are temporarily closed.');
  } finally {
    await settings.update({ requests: { enabled: true } } as never);
  }
});

test('requestsClosure: the one decision, pure', () => {
  const mix = { name: 'Late Mix', hotMix: { enabled: true } };
  assert.deepEqual(requestsClosure({ disabledByEnv: false, stationEnabled: undefined, show: null }), { open: true });
  assert.deepEqual(requestsClosure({ disabledByEnv: true, stationEnabled: true, show: null }), { open: false, reason: 'station', message: 'Requests are temporarily closed.' });
  assert.equal((requestsClosure({ disabledByEnv: false, stationEnabled: false, show: mix }) as any).reason, 'station');
  assert.deepEqual(requestsClosure({ disabledByEnv: false, stationEnabled: true, show: mix }), { open: false, reason: 'hot-mix', message: "Requests are closed during Late Mix: it's a continuous mix." });
  assert.match((requestsClosure({ disabledByEnv: false, stationEnabled: true, show: { hotMix: { enabled: true } } }) as any).message, /during this show/);
});

// ─── The saved show ─────────────────────────────────────────────────────────

test('the block survives a cold load, and reaches the resolved show the pick paths read', async () => {
  await onAir({ hotMix: { enabled: true, maxStepPct: 4, curve: [{ at: 100, bpm: 130 }, { at: 0, bpm: 120 }], closeRequests: false, phraseBars: 16, phraseMix: true } });
  setCache(null);
  await settings.load();
  const stored = settings.get().shows.find((s: any) => s.id === 's_mix');
  assert.deepEqual(stored.hotMix, {
    enabled: true, maxStepPct: 4, curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 130 }], closeRequests: false, phraseBars: 16, phraseMix: true,
  });
  assert.deepEqual(settings.resolveActiveShow()?.hotMix, stored.hotMix);
});
