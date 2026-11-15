// The queue side of a DJ Hot Mix seam: queue.planHotMixSeam gathers the show,
// the two grids and the outgoing track's ends, stamps the plan on both items,
// and getAnnotatedUri writes the keys radio.liq reads. hot-mix-seam.test.ts
// drives the pure planner.
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-hot-mix-seam-drain-'));
process.env.STATE_DIR = stateDir;

const settings = await import('../src/settings.js');
const db = await import('../src/music/library-db.js');
const { queue } = await import('../src/broadcast/queue.js');
const { getAnnotatedUri } = await import('../src/music/subsonic.js');
const { incomingStamps } = await import('../src/music/hot-mix-seam.js');
const liq = await import('../src/settings/liquidsoap.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const here = dirname(fileURLToPath(import.meta.url));
const RADIO_LIQ = readFileSync(join(here, '..', '..', 'liquidsoap', 'radio.liq'), 'utf8');

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

const answer = (bpm: number, anchorMs: number) => ({
  version: 1, engine: 'beat_this', model: 'final0', bpm, beatsPerBar: 4,
  segments: [{ anchorMs, periodUs: Math.round(60e6 / bpm), beats: 600, downbeatMs: anchorMs }],
  coverage: 0.97, residualMs: 5, downbeatAgreement: 0.9, mainShare: 0.99, decodedMs: 300_000,
}) as import('../src/music/library-db/grid.js').GridAnswer;

function track(id: string, bpm: number, anchorMs: number) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: id, duration: 300 } as never);
  db.writeGrid(id, answer(bpm, anchorMs));
  return { id, title: id, artist: 'A', album: id, duration: 300 };
}
const A = track('out-120', 120, 500);
const B = track('in-123', 123, 200);
const C = track('far-131', 131, 200);
const Z = track('top-121', 121, 0);

async function onAir(hotMix: Record<string, unknown> | undefined) {
  await settings.load();
  const personaId = settings.get().personas[0].id;
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill('mix');
  await settings.update({
    shows: [{ id: 'mix', name: 'Late Mix', topic: 'techno', personaId, ...(hotMix ? { hotMix } : {}) }],
    schedule: week,
  });
}

const NO_TRIM = { cueInSec: null, cueOutSec: null };
const pairOf = (a: typeof A, b: typeof B) => {
  const item = { track: { ...a } } as never as Parameters<typeof queue.planHotMixSeam>[0];
  const successor = { track: { ...b } } as never as Parameters<typeof queue.planHotMixSeam>[1];
  queue.current = null;
  queue.upcoming = [item, successor];
  return { item, successor };
};
const plan = (item: Parameters<typeof queue.planHotMixSeam>[0], successor: Parameters<typeof queue.planHotMixSeam>[1], boundaryCueSec: number | null = null) =>
  queue.planHotMixSeam(item, successor, { trim: NO_TRIM, endSecs: [300], boundaryCueSec });

beforeEach(() => {
  queue._hotMixStretchBuilt = async () => true;
  queue.djLog.length = 0;
});

test('a Hot Mix show stamps both sides of the seam, tied by one id', async () => {
  await onAir({ enabled: true });
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, queue.djLog.map((l) => l.message).join('\n'));
  assert.equal(item.mixOut.id, successor.mixIn.id);
  assert.equal(item.mixOut.end, null, 'inside the step, the outgoing track is untouched');
  assert.ok(Math.abs(successor.mixIn.tempo - 120 / 123) < 1e-5);
  assert.equal(successor.mixIn.inCueSec, 0.2);
  assert.equal(item.track.crossSec, item.mixOut.leadSec, 'an older mixer crossfades over the overlap');
  assert.equal(queue.liveMixIn(successor), successor.mixIn);
  // What the mixer reads.
  const out = getAnnotatedUri(item.track, { mixOut: item.mixOut, cueOutSec: item.mixOut.outCueSec });
  assert.match(out, new RegExp(`liq_mix_out="${item.mixOut.id}"`));
  assert.match(out, /liq_mix_lead="16\.0000"/);
  assert.doesNotMatch(out, /liq_mix_end_tempo/);
  const inn = getAnnotatedUri(successor.track, { mixIn: successor.mixIn, cueInSec: successor.mixIn.inCueSec });
  assert.match(inn, new RegExp(`liq_mix_in="${item.mixOut.id}"`));
  assert.match(inn, /liq_mix_tempo="0\.975610"/);
  assert.match(inn, /liq_mix_hold="16\.0000"/);
  assert.match(inn, /liq_mix_glide="16\.0000"/);
  // The landing rides its own key, never the clip seam's.
  const landed = getAnnotatedUri(successor.track, { mixIn: successor.mixIn, mixCueLateSec: -0.0239 });
  assert.match(landed, /liq_mix_cue_late="-0\.023900"/);
  assert.doesNotMatch(landed, /liq_clip_cue_late/);
  // The outgoing side's OWN cue-in landing moves its end (cue_out counts from
  // the asked cue-in): stamped with its exit, never without one.
  const outLanded = getAnnotatedUri(item.track, { mixOut: item.mixOut, mixOutLateSec: -0.013108 });
  assert.match(outLanded, /liq_mix_out_late="-0\.013108"/);
  assert.doesNotMatch(getAnnotatedUri(item.track, { mixOutLateSec: -0.013108 }), /liq_mix_out_late/);
  assert.doesNotMatch(getAnnotatedUri(item.track, { mixOut: item.mixOut, mixOutLateSec: -0.2 }), /liq_mix_out_late/, 'outside the reader bounds');
  // Every key it writes is one radio.liq reads.
  for (const key of ['liq_mix_out', 'liq_mix_in', 'liq_mix_lead', 'liq_mix_tempo', 'liq_mix_hold', 'liq_mix_glide',
    'liq_mix_end_tempo', 'liq_mix_end_from', 'liq_mix_end_ramp', 'liq_mix_cue_late', 'liq_mix_out_late']) {
    assert.ok(RADIO_LIQ.includes(`"${key}"`), `radio.liq reads ${key}`);
  }
});

test('no show, a show without Hot Mix, a gap past twice the step: no stamps', async () => {
  await onAir(undefined);
  let p = pairOf(A, B);
  await plan(p.item, p.successor);
  assert.equal(p.item.mixOut, undefined);
  assert.equal(p.successor.mixIn, undefined);

  await onAir({ enabled: true });
  p = pairOf(A, C);
  await plan(p.item, p.successor);
  assert.equal(p.item.mixOut, undefined);
  assert.ok(queue.djLog.some((l) => /Hot Mix: plain crossfade .* past twice the 3 % sync limit/.test(l.message)));
});

test('it never plans for a mixer without the stretch, nor across a show change', async () => {
  await onAir({ enabled: true });
  queue._hotMixStretchBuilt = async () => false;
  let p = pairOf(A, B);
  await plan(p.item, p.successor);
  assert.equal(p.item.mixOut, undefined);
  assert.ok(queue.djLog.some((l) => /restart the mixer/.test(l.message)));

  queue._hotMixStretchBuilt = async () => true;
  p = pairOf(A, B);
  await plan(p.item, p.successor, 200);
  assert.equal(p.item.mixOut, undefined);
});

test('a re-plan clears the old stamps; a successor already sent keeps its own', async () => {
  await onAir({ enabled: true });
  const p = pairOf(A, B);
  await plan(p.item, p.successor);
  const first = p.item.mixOut!.id;
  p.successor.track = { ...C } as never;
  await plan(p.item, p.successor);
  assert.equal(p.item.mixOut, undefined, 'the new pair does not mix');
  assert.equal(p.successor.mixIn, undefined);
  assert.ok(first);
});

test('the seam into a track stands only while its planned predecessor is still ahead of it', async () => {
  await onAir({ enabled: true });
  const p = pairOf(A, B);
  await plan(p.item, p.successor);
  assert.ok(queue.liveMixIn(p.successor));
  // A request lands between them.
  queue.upcoming = [p.item, { track: { id: 'req', title: 'req' } } as never, p.successor];
  assert.equal(queue.liveMixIn(p.successor), null);
  // The predecessor is on air now: still standing.
  queue.current = p.item as never;
  queue.upcoming = [p.successor];
  assert.ok(queue.liveMixIn(p.successor));
});

test('the stretch switch follows the shows, and its flip asks for a mixer restart', async () => {
  await onAir(undefined);
  assert.equal(liq.hotMixStretchWanted(settings.get()), false);
  const personaId = settings.get().personas[0].id;
  const on = await settings.update({ shows: [{ id: 'mix', name: 'Late Mix', topic: 'techno', personaId, hotMix: { enabled: true } }] });
  assert.equal(on.requiresRestart, true);
  assert.equal(readFileSync(liq.LIQ_HOTMIX_PATH, 'utf8'), 'true');
  const again = await settings.update({ shows: [{ id: 'mix', name: 'Late Mix', topic: 'house', personaId, hotMix: { enabled: true } }] });
  assert.equal(again.requiresRestart, false, 'another edit with Hot Mix still on needs none');
  const off = await settings.update({ shows: [{ id: 'mix', name: 'Late Mix', topic: 'house', personaId }] });
  assert.equal(off.requiresRestart, true);
  assert.equal(readFileSync(liq.LIQ_HOTMIX_PATH, 'utf8'), 'false');
  // Malformed reads as off, as everywhere else.
  assert.equal(liq.hotMixStretchWanted({ shows: [{ hotMix: 'on' }] }), false);
});

test('a successor whose downbeat is its first sample keeps the seam into it', async () => {
  // On air, 15 Nov: B's planned cue-in was 0 s, the drain keeps no zero cue,
  // and the handoff dropped every incoming stamp: B aired unstretched, its
  // start not held for the downbeat.
  await onAir({ enabled: true });
  const { item, successor } = pairOf(A, Z);
  await plan(item, successor);
  assert.ok(successor.mixIn, queue.djLog.map((l) => l.message).join('\n'));
  assert.equal(successor.mixIn.inCueSec, 0);
  const stamps = incomingStamps(queue.liveMixIn(successor), undefined, null);
  assert.equal(stamps.mixIn, successor.mixIn);
  const inn = getAnnotatedUri(successor.track, { mixIn: stamps.mixIn, mixCueLateSec: stamps.cueLateSec });
  assert.match(inn, new RegExp(`liq_mix_in="${item.mixOut!.id}"`));
  assert.match(inn, /liq_mix_tempo="/);
  assert.doesNotMatch(inn, /liq_cue_in/);
});

test('the stretch is timed by the audio it has produced, never the stream clock', () => {
  // st.time() follows the stream clock, which cross re-syncs after reading a
  // transition's opening in one burst: on air it jumped by the whole overlap
  // and the glide back to the incoming track's own tempo never ran.
  const body = RADIO_LIQ.slice(RADIO_LIQ.indexOf('def hot_mix_tempo(s) ='), RADIO_LIQ.indexOf('music = if hot_mix_stretch() then hot_mix_tempo(music)'));
  assert.ok(body.length > 0);
  assert.match(body, /st\.on_frame\(before=false, synchronous=true, fun \(\) -> now := now\(\) \+ frame\.duration\(\)\)/);
  assert.doesNotMatch(body.replace(/#.*$/gm, ''), /st\.time\(\)/);
  // The incoming wait follows the outgoing track's own landing too.
  assert.match(RADIO_LIQ, /mix_seam_lead = mix_lead - mix_late \/ mix_r \+ mix_a_late \/ mix_a_q/);
});
