// DJ Hot Mix through the real pick paths, with only HTTP stubbed: the Agentic
// discovery tools (and so the Track Shortlist, which runs its searches through
// them), the stateless pool behind them, a steer, the request route, and the
// saved show across a cold load. The show is a real takeover, so what reaches
// each path is what settings.resolveActiveShow says.
//
// The rules pinned here: off is unchanged; the tools are HARD on the window; the
// pool never starves, it takes the nearest tempos; requests close by default and
// the toggle opens them. Run: `npm test -- hot-mix-pick-paths`.

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

type Song = { id: string; title: string; artist: string; duration: number; genre: string; genres: Array<{ name: string }>; bpm?: number };
let seq = 0;
const song = (id: string, bpm?: number): Song => ({
  id, title: id, artist: `Act ${++seq}`, duration: 300, genre: 'House', genres: [{ name: 'House' }],
  ...(bpm === undefined ? {} : { bpm }),
});

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

function stubQueue(onAirBpm: number | null = 124) {
  const q = Object.create(queue);
  q.current = { track: { id: 'on-air', title: 'On Air', artist: 'On Air Act', ...(onAirBpm == null ? {} : { bpm: onAirBpm }) } };
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

// ─── Agentic discovery tools ────────────────────────────────────────────────

test('agentic: the live scope measures the window from the track on air, and every tool is hard on it', async () => {
  await onAir(MIX);
  random = [IN, HALF, FAR, UNKNOWN];
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q);
  assert.deepEqual(scope.tempoWindow, { anchorBpm: 124, maxStepPct: 6, targetBpm: null, toward: null });
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  assert.deepEqual([...seen.keys()].sort(), ['half-time', 'in-window']);
});

test('agentic: an explicit pick anchor, not the track on air, is what the step is measured from', async () => {
  await onAir(MIX);
  const { q } = stubQueue(124);
  const { scope } = await livePickerScope(q, { pickAnchor: { id: 'queued', title: 'Queued', artist: 'Q', bpm: 140 } });
  assert.equal(scope.tempoWindow?.anchorBpm, 140);
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
  random = [IN, FAR, UNKNOWN];
  const { q, logs } = stubQueue(124);
  const picked = await pool(q, show);
  assert.ok(picked);
  assert.deepEqual(offered[0].map((c) => c.id), ['in-window']);
  assert.ok(logs.some((l) => /Hot Mix "Future Frequencies": tempo window 117-131 BPM around 124/.test(l)), logs.join('\n'));
});

test('pool: with nothing inside the window it never starves, it takes the nearest tempo', async () => {
  const show = await onAir(MIX);
  random = [song('very-far', 170), song('nearest', 140), UNKNOWN];
  const { q, logs } = stubQueue(124);
  const picked = await pool(q, show);
  assert.ok(picked);
  // 140 is the nearest (13 %); 170 reads as 85, 31 % away, past one step
  // beyond it, so only the nearest reaches the model.
  assert.deepEqual(offered[0].map((c) => c.id), ['nearest']);
  assert.ok(logs.some((l) => /nothing inside .* taking the nearest tempos/.test(l)), logs.join('\n'));
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
