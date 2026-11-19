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
  queue._hotMixBassBuilt = async () => true;
  // The safe transition has its own tests below; off, every refusal is the
  // plain crossfade these tests were written against.
  queue._hotMixSafeBuilt = async () => false;
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

test('an outgoing track whose cue-in landed late buffers that much more, on both bounds', () => {
  // A FLAC outgoing 80-95 ms late plus an incoming 14-25 ms early overran the
  // 0.1 s slack, and the mixer fell back to a plain crossfade (on air, 16 Nov).
  assert.match(RADIO_LIQ, /def mix_out_late_room\(m\) =/);
  assert.match(RADIO_LIQ, /own = if mix_lead >= 0\. then mix_lead \+ clip_seam_slack \+ mix_out_late_room\(m\) else own end/);
  assert.match(RADIO_LIQ, /mix_max_d = mix_lead \+ clip_seam_slack \+ mix_out_late_room\(a\.metadata\) \+ frame\.duration\(\)/);
});

// ─── The phrase mix (show.hotMix.phraseMix) and the phrase length ───────────

// Stored bars for a track: `bars` four-beat bars of `barUs` from `startMs`, the
// full section (hard kick, bass, mids) on bars first..last, quiet elsewhere,
// so structurePoints reads firstHardKick = first, lastHardKick = last.
function structure(id: string, startMs: number, barUs: number, bars: number, first: number, last: number) {
  const full = (i: number) => i + 1 >= first && i + 1 <= last;
  const arr = (on: number, off: number) => Array.from({ length: bars }, (_, i) => (full(i) ? on : off));
  db.writeStructure(id, {
    version: 1,
    decodedMs: null,
    bars: {
      runs: [[startMs, barUs, bars]],
      kick: arr(0, -20), kicks: arr(4, 0), bass: arr(0, -30), mid: arr(0, -20),
      high: arr(-6, -20), level: arr(0, -20), melody: arr(10, 10),
    },
  }, db.getGrid(id)!.measuredAt);
}
// A: 150 bars of 2 s from 0.5 s, its last hard kick on bar 100.
structure('out-120', 500, 2_000_000, 150, 20, 100);
// B: 150 bars of 4 beats at 123 BPM from 0.2 s, a 64-bar intro (first hard kick on bar 65).
const B_BAR_US = 4 * Math.round(60e6 / 123);
structure('in-123', 200, B_BAR_US, 150, 65, 140);
const bBarSec = (k: number) => (200 + ((k - 1) * B_BAR_US) / 1000) / 1000;
const logText = () => queue.djLog.map((l) => l.message).join('\n');

test('phrase mix on, structure on both sides: the seam sits on the kicks', async () => {
  await onAir({ enabled: true, phraseMix: true });
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  // A's overlap starts the bar after its last hard kick (bar 101, 200.5 s) and
  // it is cut 8 bars on; B enters 8 bars before its first hard kick (bar 57).
  assert.ok(Math.abs(item.mixOut.outCueSec - (0.5 + 108 * 2)) < 1e-3, `${item.mixOut.outCueSec}`);
  assert.ok(Math.abs(successor.mixIn.inCueSec - bBarSec(57)) < 1e-3, `${successor.mixIn.inCueSec}`);
  assert.ok(Math.abs(item.mixOut.leadSec - 16) < 1e-3);
  // The bass timings, for the mixer's later step.
  assert.deepEqual(item.mixOut.bassRide, { fromSec: 0, toSec: item.mixOut.leadSec });
  assert.equal(successor.mixIn.punchSec, item.mixOut.leadSec);
  assert.match(logText(), /Hot Mix seam [\s\S]*phrase mix: out after bar 100 \(last hard kick\) \+8 bars, in at bar 57, first hard kick bar 65 at \+16s/);
  assert.doesNotMatch(logText(), /phrase mix not used/);
  // The mixer's bass move reads them: A rides its bass down, B punches on its kick.
  const keys = (uri: string) => uri.slice(0, uri.indexOf(':subhttp:'));
  const out = keys(getAnnotatedUri(item.track, { mixOut: item.mixOut, cueOutSec: item.mixOut.outCueSec }));
  assert.match(out, /liq_mix_bass="ride"/);
  const inn = keys(getAnnotatedUri(successor.track, { mixIn: successor.mixIn, cueInSec: successor.mixIn.inCueSec }));
  assert.match(inn, /liq_mix_punch="16\.0000"/);
  for (const key of ['liq_mix_bass', 'liq_mix_punch']) assert.ok(RADIO_LIQ.includes(`"${key}"`), `radio.liq reads ${key}`);
  // A seam the phrase mix did not place carries neither.
  const { bassRide: _r, ...outPlain } = item.mixOut;
  const { punchSec: _p, ...inPlain } = successor.mixIn;
  assert.doesNotMatch(keys(getAnnotatedUri(item.track, { mixOut: outPlain })) + keys(getAnnotatedUri(successor.track, { mixIn: inPlain })), /liq_mix_bass|liq_mix_punch/);
});

test('phrase mix on, sixteen bars: B enters 16 bars before its kick, a 64-beat overlap', async () => {
  await onAir({ enabled: true, phraseMix: true, phraseBars: 16 });
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  assert.ok(Math.abs(successor.mixIn.inCueSec - bBarSec(49)) < 1e-3);
  assert.ok(Math.abs(item.mixOut.leadSec - 32) < 1e-3);
  assert.ok(Math.abs(item.mixOut.outCueSec - (0.5 + 116 * 2)) < 1e-3);
  assert.match(logText(), /\+16 bars, in at bar 49, first hard kick bar 65 at \+32s/);
});

test('phrase mix on, an intro shorter than the show asks: the overlap is the window\'s, the kick on the cut', async () => {
  await onAir({ enabled: true, phraseMix: true, phraseBars: 16 });
  // A 12-bar intro (first hard kick on bar 13) holds one 8-bar phrase, not 16.
  const S = track('in-short-123', 123, 200);
  structure('in-short-123', 200, B_BAR_US, 150, 13, 140);
  const { item, successor } = pairOf(A, S);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  assert.ok(Math.abs(successor.mixIn.inCueSec - bBarSec(5)) < 1e-3, `${successor.mixIn.inCueSec}`);
  // Eight bars of A: the overlap and A's cut follow the window, not the show's 16.
  assert.ok(Math.abs(item.mixOut.leadSec - 16) < 1e-3, `${item.mixOut.leadSec}`);
  assert.ok(Math.abs(item.mixOut.outCueSec - (0.5 + 108 * 2)) < 1e-3, `${item.mixOut.outCueSec}`);
  assert.equal(successor.mixIn.punchSec, item.mixOut.leadSec);
  assert.match(logText(), /\+8 bars, in at bar 5, first hard kick bar 13 at \+16s/);
});

test('phrase mix on, a mixer without the bass move: never the placed seam (the trim alone lost the blind tests)', async () => {
  await onAir({ enabled: true, phraseMix: true });
  queue._hotMixBassBuilt = async () => false;
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  assert.match(logText(), /Hot Mix: phrase mix not used for "out-120" → "in-123" \(the mixer has no bass move: rebuild the broadcast image\): beat mix as before/);
  assert.ok(Math.abs(successor.mixIn.inCueSec - bBarSec(57)) > 1, 'the searched seam, not the window');
  assert.equal(item.mixOut.bassRide, undefined);
  assert.equal(successor.mixIn.punchSec, undefined);
});

test('phrase mix on, no structure on the incoming track: one booth line, then the seam as before', async () => {
  await onAir({ enabled: true, phraseMix: true });
  const { item, successor } = pairOf(A, Z);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  const lines = queue.djLog.filter((l) => /phrase mix not used/.test(l.message));
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /^Hot Mix: phrase mix not used for "out-120" → "top-121" \(no structure measured on the incoming track\): beat mix as before$/);
  assert.equal(successor.mixIn.inCueSec, 0, 'the searched seam: B on its first downbeat');
  assert.equal(item.mixOut.bassRide, undefined);
  assert.equal(successor.mixIn.punchSec, undefined);
});

test('phrase mix on, a window it cannot use: the searched seam, and the booth says why', async () => {
  await onAir({ enabled: true, phraseMix: true });
  // The structure cannot place it: A ends (a trim, a cap) before any 8-bar
  // transition after its full section starts.
  let p = pairOf(A, B);
  await queue.planHotMixSeam(p.item, p.successor, { trim: NO_TRIM, endSecs: [45], boundaryCueSec: null });
  assert.match(logText(), /phrase mix not used for "out-120" → "in-123" \(the outgoing track ends before an 8-bar transition fits\): beat mix as before/);
  assert.ok(p.item.mixOut && p.item.mixOut.outCueSec <= 45, 'the searched seam still plans');
  // The grid does not hold it: bars stored 100 ms off the grid's downbeats.
  queue.djLog.length = 0;
  const S = track('in-shift-123', 123, 200);
  structure(S.id, 300, B_BAR_US, 150, 65, 140);
  p = pairOf(A, S);
  await plan(p.item, p.successor);
  assert.match(logText(), /phrase mix not used for "out-120" → "in-shift-123" \(the phrase window's incoming downbeat is not on a trusted grid\): beat mix as before/);
  assert.equal(p.successor.mixIn?.inCueSec, 0.2);
  assert.equal(p.successor.mixIn?.punchSec, undefined);
});

test('phrase mix off: exactly the seam it always was, structure or not', async () => {
  await onAir({ enabled: true });
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  assert.equal(successor.mixIn.inCueSec, 0.2);
  assert.ok(Math.abs(item.mixOut.leadSec - 16) < 1e-3);
  assert.equal(item.mixOut.bassRide, undefined);
  assert.equal(successor.mixIn.punchSec, undefined);
  assert.doesNotMatch(logText(), /phrase mix/);
});

test('phrase length 16 without the phrase mix: a 64-beat overlap on the searched seam', async () => {
  await onAir({ enabled: true, phraseBars: 16 });
  const { item, successor } = pairOf(A, B);
  await plan(item, successor);
  assert.ok(item.mixOut && successor.mixIn, logText());
  assert.ok(Math.abs(item.mixOut.leadSec - 32) < 1e-3);
  assert.equal(successor.mixIn.holdSec, item.mixOut.leadSec);
  assert.equal(successor.mixIn.inCueSec, 0.2);
  assert.equal(item.track.crossSec, item.mixOut.leadSec);
});

// The safe transition (music/safe-out-policy.ts, radio.liq HOT MIX SAFE OUT):
// a Hot Mix seam that cannot be beat-matched rides the outgoing bass out and
// lets the incoming track in at full on its downbeat, never an unsynced
// overlap. Blind set 5: acceptable on all three pairs.
test('a gap past twice the step: the safe transition, stamped on both sides, tied by one id', async () => {
  queue._hotMixSafeBuilt = async () => true;
  await onAir({ enabled: true });
  const { item, successor } = pairOf(A, C);
  await plan(item, successor);
  assert.equal(item.mixOut, undefined);
  assert.ok(item.safeOut && successor.safeIn, queue.djLog.map((l) => l.message).join('\n'));
  assert.equal(item.safeOut.id, successor.safeIn.id);
  // A's bar lines at 0.5 + 2k s; the latest with a bar after it inside 300 s.
  assert.equal(item.safeOut.barSec, 2);
  assert.equal(item.safeOut.outCueSec, 298.5);
  // C's first downbeat at 0.2 s, entered 0.1 s before it.
  assert.equal(successor.safeIn.inCueSec, 0.1);
  assert.equal(item.safeOut.leadSec, 2.1);
  assert.equal(item.track.crossSec, 6.1, 'the two ride bars and the lead');
  assert.equal(queue.liveSafeIn(successor), successor.safeIn);
  assert.ok(queue.djLog.some((l) => /Hot Mix: safe transition .* past twice the 3 % sync limit\): outgoing bass out over 2 bars of 2s \(bar from the grid\), cut 298\.5s, incoming at full on its first downbeat, cue-in 0\.1s/.test(l.message)));
  const out = getAnnotatedUri(item.track, { safeOut: item.safeOut, cueOutSec: item.safeOut.outCueSec });
  assert.match(out, /liq_safe_out="2\.0000"/);
  assert.match(out, /liq_safe_lead="2\.1000"/);
  assert.doesNotMatch(getAnnotatedUri(item.track, { safeOut: item.safeOut, mixOut: { id: 'x', leadSec: 16, end: null } }), /liq_safe_out/,
    'never beside a Hot Mix seam\'s own stamps');
  for (const key of ['liq_safe_out', 'liq_safe_lead']) assert.ok(RADIO_LIQ.includes(`"${key}"`), `radio.liq reads ${key}`);
  assert.ok(RADIO_LIQ.includes('"hotmix_safe"'), 'the capability the controller asks');
});

test('the safe transition: never across a show change, never on a mixer without it', async () => {
  await onAir({ enabled: true });
  queue._hotMixSafeBuilt = async () => true;
  let p = pairOf(A, C);
  await queue.planHotMixSeam(p.item, p.successor, { trim: NO_TRIM, endSecs: [300], boundaryCueSec: 280 });
  assert.equal(p.item.safeOut, undefined);
  assert.ok(queue.djLog.some((l) => /plain crossfade .*the show changes at this seam/.test(l.message)));
  queue._hotMixSafeBuilt = async () => false;
  p = pairOf(A, C);
  await plan(p.item, p.successor);
  assert.equal(p.item.safeOut, undefined);
  assert.ok(queue.djLog.some((l) => /plain crossfade .*the mixer has no safe transition: rebuild the broadcast image/.test(l.message)));
});

test('the safe transition covers the other refusals too: a mixer without the stretch, a track outside the library', async () => {
  await onAir({ enabled: true });
  queue._hotMixSafeBuilt = async () => true;
  queue._hotMixStretchBuilt = async () => false;
  let p = pairOf(A, B);
  await plan(p.item, p.successor);
  assert.ok(p.item.safeOut, 'a beat-matchable pair on a mixer without the stretch');
  assert.equal(p.item.mixOut, undefined);
  queue._hotMixStretchBuilt = async () => true;
  p = pairOf(A, { ...B, id: '' } as typeof B);
  await plan(p.item, p.successor);
  assert.ok(p.item.safeOut, 'no library id on the incoming side');
  assert.equal(p.successor.safeIn, undefined, 'no grid: it keeps its own cue-in');
});

test('a re-plan clears the safe stamps, and the seam into a track stands only while its planner is ahead', async () => {
  queue._hotMixSafeBuilt = async () => true;
  await onAir({ enabled: true });
  const { item, successor } = pairOf(A, C);
  await plan(item, successor);
  assert.ok(item.safeOut && successor.safeIn);
  queue.upcoming = [successor];
  assert.equal(queue.liveSafeIn(successor), null, 'its planner is gone');
  queue.upcoming = [item, successor];
  const p2 = pairOf(A, B);
  item.safeOut = p2.item.safeOut;
  await plan(p2.item, p2.successor);
  assert.equal(p2.item.safeOut, undefined, 'a pair it can mix is the beat-matched seam');
  assert.ok(p2.item.mixOut);
});
