// The drain's pre-commit window ends where the mixer needs the track
// (broadcast/drain-policy.ts seamWindowSec), through the REAL
// queue.drainToLiquidsoap against a fake mixer on a real socket.
//
// THE DEFECT. The intro render's budget was measured to the END of the track
// ahead. Out of a Hot Mix seam the mixer reaches for the next track a whole
// lead (about 32 s at 16 bars) before that end, so a slow TTS render could
// commit the planned partner after the mixer had already switched to the coast,
// which then aired in a seam planned for another track. Now the window ends at
// the seam's start, less the handoff margin; a plain crossfade keeps its clock.
//
// Run: npm test -- seam-window-drain

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const base = createTempDir(join(tmpdir(), 'subwave-seam-window-drain-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
process.env.NAVIDROME_URL = 'http://seam-window.invalid';

// The mixer answers every telnet command with a plain OK.
const mixer = createServer((socket: Socket) => {
  socket.on('error', () => {});
  socket.once('data', () => socket.end('OK\nEND\n'));
});
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
};

const settings = await import('../src/settings.js');
await settings.load();
const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');
const { SEAM_HANDOFF_MARGIN_SEC, MIXER_SEAM_SLACK_SEC, DRAIN_COMMIT_RESERVE_SEC } = await import('../src/broadcast/drain-policy.js');

type Item = {
  track: { id: string; title: string; artist: string; album: string; duration: number };
  sent: boolean;
  aiPicked?: boolean;
  introScript?: string;
  startedAt?: string;
  mixOut?: { id: string; leadSec: number; end: null; outCueSec: number } | null;
  safeOut?: { id: string; barSec: number; leadSec: number; outCueSec: number } | null;
};
const q = queue as unknown as {
  upcoming: Item[];
  current: Item | null;
  djLog: { message: string }[];
  startIntroRender: (item: Item) => unknown;
  pairDrainActive: () => boolean;
  remainingUntilItemAirs: (item: Item) => number | null;
  remainingUntilItemNeeded: (item: Item) => number | null;
  _persistTimer?: NodeJS.Timeout;
  _recentPlaysTimer?: NodeJS.Timeout;
};

const realStartIntroRender = q.startIntroRender;
let renders = 0;
let run = 0;

// The track on air: 300 s long, started 270 s ago, so 30 s from its end.
const onAir = (extra: Partial<Item> = {}): Item => ({
  track: { id: `out-${run}`, title: 'Outgoing', artist: 'A', album: 'A', duration: 300 },
  sent: true,
  startedAt: new Date(Date.now() - 270_000).toISOString(),
  ...extra,
});
const next = (): Item => ({
  track: { id: `next-${run}`, title: 'Next', artist: 'B', album: 'B', duration: 240 },
  sent: false,
  aiPicked: true,
  introScript: 'Here comes the next one.',
});
const lines = () => q.djLog.map(l => l.message);

beforeEach(() => {
  run += 1;
  renders = 0;
  q.startIntroRender = () => { renders += 1; return null; };
  if (existsSync(config.liquidsoap.queueFile)) rmSync(config.liquidsoap.queueFile);
  q.upcoming = [];
  q.current = null;
  q.djLog.length = 0;
});

after(async () => {
  q.startIntroRender = realStartIntroRender;
  globalThis.fetch = realFetch;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  await removeTempDir(base);
});

test('out of a Hot Mix seam the intro render window ends at the seam, not at the track end', async () => {
  // 30 s to the end leaves an 18 s render window on the end clock, but the
  // mixer reaches for this track 16.1 s before that end: what is left after the
  // handoff margin and the commit reserve is no honest render window.
  q.current = onAir({ mixOut: { id: 'p1', leadSec: 16, end: null, outCueSec: 300 } });
  const item = next();
  q.upcoming = [item];
  await queue.drainToLiquidsoap(true);

  assert.equal(renders, 0, 'no render started for a track the mixer needs within the commit reserve');
  assert.ok(lines().some(l => /Intro render deferred to air time — "Next" airs too soon to render ahead/.test(l)), lines().join('\n'));
  assert.equal(item.sent, true, 'the music is still committed');
});

test('the window is shorter by the seam overlap and the handoff margin, and only out of a Hot Mix seam', () => {
  const item = next();
  q.current = onAir();
  q.upcoming = [item];
  const toEnd = q.remainingUntilItemAirs(item)!;
  assert.ok(Math.abs(q.remainingUntilItemNeeded(item)! - toEnd) < 0.05, 'a plain crossfade keeps the end-of-track clock');

  q.current = onAir({ mixOut: { id: 'p1', leadSec: 32, end: null, outCueSec: 300 } });
  const shorter = toEnd - q.remainingUntilItemNeeded(item)!;
  assert.ok(Math.abs(shorter - (32 + MIXER_SEAM_SLACK_SEC + SEAM_HANDOFF_MARGIN_SEC)) < 0.05, `shorter by ${shorter}s`);

  // The safe transition's buffer: two bars plus its lead plus the slack.
  q.current = onAir({ safeOut: { id: 's1', barSec: 2, leadSec: 2.1, outCueSec: 298.5 } });
  const safe = toEnd - q.remainingUntilItemNeeded(item)!;
  assert.ok(Math.abs(safe - (6.1 + MIXER_SEAM_SLACK_SEC + SEAM_HANDOFF_MARGIN_SEC)) < 0.05, `shorter by ${safe}s`);

  // Behind a sent track that leaves by a Hot Mix seam, the overlap is ITS lead.
  const ahead = { ...next(), sent: true, mixOut: { id: 'p2', leadSec: 16, end: null, outCueSec: 240 } };
  const behind = next();
  q.current = onAir();
  q.upcoming = [ahead, behind];
  const aheadToEnd = q.remainingUntilItemAirs(behind)!;
  assert.ok(Math.abs(aheadToEnd - q.remainingUntilItemNeeded(behind)! - (16 + MIXER_SEAM_SLACK_SEC + SEAM_HANDOFF_MARGIN_SEC)) < 0.05);
});

test('a plain crossfade keeps the end-of-track render window', async () => {
  q.current = onAir();
  const item = next();
  q.upcoming = [item];
  await queue.drainToLiquidsoap(true);

  assert.equal(renders, 1, 'the render is attempted with the end clock\'s window');
  assert.ok(!lines().some(l => /Intro render deferred/.test(l)), lines().join('\n'));
  assert.ok(30 - DRAIN_COMMIT_RESERVE_SEC > 5);
});

test('a held track goes out once the seam into it, not the end ahead, is under the hard deadline', async () => {
  const realPairDrain = q.pairDrainActive;
  q.pairDrainActive = () => true;
  try {
    // 75 s from the end: a plain seam holds it for its successor...
    q.current = onAir({ startedAt: new Date(Date.now() - 225_000).toISOString() });
    let item = next();
    delete item.introScript;
    q.upcoming = [item];
    await queue.drainToLiquidsoap();
    assert.equal(item.sent, false, 'held: 75 s is past the hard deadline');
    // ...but out of a 32 s Hot Mix lead the mixer asks for it in 43 s, less
    // the handoff margin, so it goes out now with its own stamps.
    q.current = onAir({ startedAt: new Date(Date.now() - 225_000).toISOString(), mixOut: { id: 'p3', leadSec: 32, end: null, outCueSec: 300 } });
    item = next();
    delete item.introScript;
    q.upcoming = [item];
    await queue.drainToLiquidsoap();
    assert.equal(item.sent, true, 'sent: the seam into it is under the hard deadline');
  } finally {
    q.pairDrainActive = realPairDrain;
  }
});
