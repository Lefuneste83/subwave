import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLIDE_SEC, OVERLAP_BEATS, RAMP_BEATS, SYNC_MAX_PCT, WINDOW_MATCH_SEC,
  incomingStamps, outAt, planHotMixSeam, profileOf, punchAfterShift, shiftInCue, srcAt,
  type SeamInput, type StartStretch, type EndStretch,
} from '../src/music/hot-mix-seam.js';

// A one-segment grid at `bpm`, beats from `anchor` s, a downbeat on its first beat.
const grid = (bpm: number, anchor = 0.5, beats = 600) => ({
  bpm,
  beatsPerBar: 4,
  segments: [{ anchorMs: anchor * 1000, periodUs: 60e6 / bpm, beats, downbeatMs: anchor * 1000 }],
});

const pair = (aBpm: number, bBpm: number, over: Partial<SeamInput> = {}): SeamInput => ({
  stepPct: 3,
  a: { ...grid(aBpm), cueInSec: 0, endSec: 240, start: null },
  b: { ...grid(bBpm, 0.2), cueInSec: 0, durationSec: 300 },
  ...over,
});

// radio.liq's hot_mix_tempo, written out as the mixer reads it, and integrated
// in 1 ms steps: the planner's closed forms must agree with it.
function liqTempo(start: StartStretch | null, end: EndStretch | null, e: number): number {
  const r = start?.tempo ?? 1;
  const hold = start?.holdSec ?? 0;
  const glide = start?.glideSec ?? 0;
  const q = end?.tempo ?? 1;
  const from = end?.fromSec ?? -1;
  const ramp = end?.rampSec ?? 0;
  if (r !== 1 && e < hold) return r;
  if (r !== 1 && glide > 0 && e < hold + glide) return r + (1 - r) * (e - hold) / glide;
  if (q !== 1 && from >= 0 && e >= from) return ramp > 0 && e < from + ramp ? 1 + (q - 1) * (e - from) / ramp : q;
  return 1;
}
function liqSrcAt(start: StartStretch | null, end: EndStretch | null, e: number): number {
  let s = 0;
  const dt = 0.001;
  for (let t = 0; t < e; t += dt) s += liqTempo(start, end, t + dt / 2) * Math.min(dt, e - t);
  return s;
}

test('a gap inside the step syncs the incoming track alone; the outgoing one is untouched', () => {
  const v = planHotMixSeam(pair(120, 123));
  assert.ok(v.ok, JSON.stringify(v));
  const p = v.plan;
  assert.equal(p.kind, 'incoming');
  assert.equal(p.aEnd, null);
  assert.ok(Math.abs(p.bStart.tempo - 120 / 123) < 1e-6);
  assert.equal(p.bStart.holdSec, p.leadSec);
  assert.equal(p.bStart.glideSec, GLIDE_SEC);
  // Eight bars of A at its own tempo, cut on a bar line before its end.
  assert.ok(Math.abs(p.leadSec - OVERLAP_BEATS * 0.5) < 1e-3);
  assert.ok(p.outCueSec <= 240);
  const barsFromDownbeat = (p.outCueSec - p.leadSec - 0.5) / (4 * 0.5);
  assert.ok(Math.abs(barsFromDownbeat - Math.round(barsFromDownbeat)) < 1e-6, 'the overlap starts on a downbeat');
  // The incoming track starts on its first downbeat at or after its cue-in.
  assert.equal(p.inCueSec, 0.2);
});

test('past the step and up to twice it, the gap is split: both move halfway', () => {
  const v = planHotMixSeam(pair(120, 125));
  assert.ok(v.ok, JSON.stringify(v));
  const p = v.plan;
  assert.equal(p.kind, 'split');
  const q = Math.sqrt(125 / 120);
  assert.ok(Math.abs(p.aEnd!.tempo - q) < 1e-6);
  assert.ok(Math.abs(p.bStart.tempo - q * 120 / 125) < 1e-6);
  // Neither moves more than the step.
  assert.ok(Math.abs(p.aEnd!.tempo - 1) * 100 <= 3);
  assert.ok(Math.abs(p.bStart.tempo - 1) * 100 <= 3);
  assert.ok(Math.abs(p.aEnd!.rampSec - RAMP_BEATS * 0.5) < 1e-3);
  // Both then play a beat every pA / q output seconds.
  assert.ok(Math.abs((60 / 125) / p.bStart.tempo - 0.5 / q) < 1e-6);
});

test('past twice the step there is no beat mix', () => {
  const v = planHotMixSeam(pair(120, 130));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /past twice the 3 % sync limit/);
});

test('the sync limit never passes SYNC_MAX_PCT, whatever the step', () => {
  const v = planHotMixSeam(pair(120, 138, { stepPct: 20 }));
  assert.equal(v.ok, false);
  assert.ok(SYNC_MAX_PCT <= 6);
});

test('octave-safe: a half-time incoming track mixes untouched against its double', () => {
  const v = planHotMixSeam(pair(124, 62));
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.plan.kind, 'incoming');
  assert.ok(Math.abs(v.plan.bStart.tempo - 1) < 1e-9);
});

test('the overlap stays inside a segment whose beat is the track\'s beat', () => {
  // The last 30 s of A are a double-time stretch of the grid: untrusted, so the
  // seam moves into the main segment and A is cut before it.
  const a = {
    bpm: 120, beatsPerBar: 4,
    segments: [
      { anchorMs: 500, periodUs: 500000, beats: 420, downbeatMs: 500 },
      { anchorMs: 210500, periodUs: 250000, beats: 118, downbeatMs: 210500 },
    ],
  };
  const v = planHotMixSeam(pair(120, 121, { a: { ...a, cueInSec: 0, endSec: 240, start: null } }));
  assert.ok(v.ok, JSON.stringify(v));
  assert.ok(v.plan.outCueSec <= 0.5 + 420 * 0.5 + 1e-6, `${v.plan.outCueSec}`);
  // No downbeat known anywhere: no seam.
  const blind = { ...a, segments: a.segments.map((s) => ({ ...s, downbeatMs: null })) };
  assert.equal(planHotMixSeam(pair(120, 121, { a: { ...blind, cueInSec: 0, endSec: 240, start: null } })).ok, false);
});

test('the outgoing track\'s effective end bounds the cut', () => {
  const v = planHotMixSeam(pair(120, 121, { a: { ...grid(120), cueInSec: 0, endSec: 100.3, start: null } }));
  assert.ok(v.ok);
  assert.ok(v.plan.outCueSec <= 100.3);
  assert.ok(v.plan.outCueSec > 100.3 - 4 * 0.5 - 1e-6, 'the last bar line that fits');
});

test('an incoming downbeat far past the cue-in is no seam', () => {
  const b = { ...grid(121, 45), cueInSec: 0, durationSec: 300 };
  assert.equal(planHotMixSeam(pair(120, 121, { b })).ok, false);
});

test('profile replay: closed forms agree with the mixer\'s rule integrated', () => {
  const start = { tempo: 0.96, holdSec: 15.68, glideSec: 16 };
  const end = { tempo: 1.02, fromSec: 150, rampSec: 8 };
  const p = profileOf(start, end);
  for (const e of [3, 15.68, 20, 31.68, 100, 150, 154, 158, 170]) {
    const want = liqSrcAt(start, end, e);
    assert.ok(Math.abs(srcAt(p, e) - want) < 2e-3, `srcAt(${e}) ${srcAt(p, e)} vs ${want}`);
    assert.ok(Math.abs(outAt(p, srcAt(p, e)) - e) < 1e-6, `outAt inverts srcAt at ${e}`);
  }
});

test('an outgoing track that was mixed in: its ramp and overlap land on its own downbeats in output time', () => {
  const start = { tempo: 0.97, holdSec: 16, glideSec: 16 };
  const v = planHotMixSeam(pair(120, 125, { a: { ...grid(120), cueInSec: 2, endSec: 200, start } }));
  assert.ok(v.ok, JSON.stringify(v));
  const p = v.plan;
  const prof = profileOf(start, p.aEnd);
  // The ramp ends where the overlap starts, and that is the downbeat D the
  // cut is OVERLAP_BEATS after (file time, relative to A's cue-in).
  const dRel = p.outCueSec - OVERLAP_BEATS * 0.5 - 2;
  const overlapStartOut = outAt(prof, dRel);
  assert.ok(Math.abs(overlapStartOut - (p.aEnd!.fromSec + p.aEnd!.rampSec)) < 1e-3);
  // And A then plays exactly leadSec more before its cut.
  assert.ok(Math.abs(outAt(prof, p.outCueSec - 2) - overlapStartOut - p.leadSec) < 1e-3);
  // The mixer's own integration agrees on where D falls.
  assert.ok(Math.abs(liqSrcAt(start, p.aEnd, overlapStartOut) - dRel) < 3e-3);
});

test('a beat-phase shift the cue-in cannot take before the file starts becomes a wait', () => {
  assert.deepEqual(shiftInCue(0.2, -0.015), { inCueSec: 0.185, waitSec: 0 });
  assert.deepEqual(shiftInCue(0.2, 0.03), { inCueSec: 0.23, waitSec: 0 });
  // A downbeat on the first sample, the kick wanting B 15 ms sooner (on air,
  // 15 Nov): the cue stays at 0 and B waits the 15 ms instead.
  assert.deepEqual(shiftInCue(0, -0.015), { inCueSec: 0, waitSec: 0.015 });
  assert.deepEqual(shiftInCue(0.01, -0.025), { inCueSec: 0, waitSec: 0.015 });
});

test('the seam into B stands on a downbeat at the top of the file, where the queue keeps no cue-in', () => {
  const mixIn = { id: 'ab12', tempo: 1.0083, holdSec: 16, glideSec: 16, inCueSec: 0 };
  // The queue keeps only positive cues: a start at 0 s arrives as no cue-in.
  assert.equal(incomingStamps(mixIn, undefined, null).mixIn, mixIn);
  assert.equal(incomingStamps(mixIn, null, null).mixIn, mixIn);
  assert.equal(incomingStamps(mixIn, 0, null).cueLateSec, null);
  // A cue-in moved elsewhere (a deeper trim) no longer starts on the downbeat.
  assert.deepEqual(incomingStamps(mixIn, 1.5, null), { mixIn: null, cueLateSec: null });
  const deep = { ...mixIn, inCueSec: 0.2 };
  assert.equal(incomingStamps(deep, 0.2, null).mixIn, deep);
  assert.equal(incomingStamps(deep, undefined, null).mixIn, null);
  // The wait the cue could not take rides the landing stamp, added to a probe.
  assert.equal(incomingStamps({ ...mixIn, waitSec: 0.015 }, undefined, null).cueLateSec, 0.015);
  assert.equal(incomingStamps({ ...deep, waitSec: 0.01 }, 0.2, -0.024).cueLateSec, -0.014);
  assert.equal(incomingStamps(deep, 0.2, 0.021).cueLateSec, 0.021);
  assert.deepEqual(incomingStamps(null, 0, null), { mixIn: null, cueLateSec: null });
});

// ─── The overlap length and the phrase window ───────────────────────────────

test('a 16-bar overlap: 64 beats of A, cut on a bar line, every beat of both sides listed', () => {
  const v = planHotMixSeam({ ...pair(120, 123), overlapBeats: 64 });
  assert.ok(v.ok, JSON.stringify(v));
  const p = v.plan;
  assert.ok(Math.abs(p.leadSec - 64 * 0.5) < 1e-3);
  assert.equal(p.bStart.holdSec, p.leadSec);
  assert.equal(p.aOverlapBeats.length, 65);
  assert.ok(Math.abs(p.aOverlapBeats[64] - p.outCueSec) < 1e-3);
  assert.ok(p.bOverlapBeats.length >= 64 && p.bOverlapBeats.length <= 65, `${p.bOverlapBeats.length}`);
  const barsFromDownbeat = (p.outCueSec - p.leadSec - 0.5) / 2;
  assert.ok(Math.abs(barsFromDownbeat - Math.round(barsFromDownbeat)) < 1e-6);
  assert.equal(p.bPunchSec, undefined, 'no window, no punch');
  // The default is today's eight bars.
  const d = planHotMixSeam(pair(120, 123));
  assert.ok(d.ok);
  assert.equal(d.plan.aOverlapBeats.length, OVERLAP_BEATS + 1);
});

// B's bar k (4 beats at 123 BPM from 0.2 s), A's bar k (2 s from 0.5 s).
const bBar = (k: number) => 0.2 + (k - 1) * 4 * 60 / 123;
const aBar = (k: number) => 0.5 + (k - 1) * 2;

test('a phrase window: A\'s overlap starts on its bar, B enters on its bar, far past its cue-in', () => {
  const window = { aStartSec: aBar(101), bEntrySec: bBar(57) };
  const v = planHotMixSeam({ ...pair(120, 123), window });
  assert.ok(v.ok, JSON.stringify(v));
  const p = v.plan;
  assert.equal(p.kind, 'incoming');
  assert.ok(Math.abs(p.outCueSec - aBar(109)) < 1e-3, `cut ${p.outCueSec}`);
  assert.ok(Math.abs(p.inCueSec - bBar(57)) < 1e-3, `cue-in ${p.inCueSec}`);
  assert.ok(p.inCueSec > 30, 'no 30 s limit on a window');
  // B's first hard kick, 8 of its bars later, plays where A is cut.
  assert.equal(p.bPunchSec, p.leadSec);
  assert.ok(Math.abs((bBar(65) - bBar(57)) / p.bStart.tempo - p.leadSec) < 1e-3);
  assert.ok(Math.abs(p.aOverlapBeats[0] - aBar(101)) < 1e-3);
  assert.ok(Math.abs(p.bOverlapBeats[0] - bBar(57)) < 1e-3);
  // Rounded structure times still find their downbeats.
  const near = planHotMixSeam({ ...pair(120, 123), window: { aStartSec: aBar(101) + 0.02, bEntrySec: bBar(57) - 0.02 } });
  assert.ok(near.ok);
  assert.equal(near.plan.outCueSec, p.outCueSec);
  assert.equal(near.plan.inCueSec, p.inCueSec);
  assert.ok(WINDOW_MATCH_SEC <= 0.03);
});

test('a 16-bar phrase window', () => {
  const v = planHotMixSeam({ ...pair(120, 123), overlapBeats: 64, window: { aStartSec: aBar(101), bEntrySec: bBar(49) } });
  assert.ok(v.ok, JSON.stringify(v));
  assert.ok(Math.abs(v.plan.outCueSec - aBar(117)) < 1e-3);
  assert.ok(Math.abs((bBar(65) - v.plan.inCueSec) / v.plan.bStart.tempo - v.plan.bPunchSec!) < 1e-3);
});

test('a split phrase window: A ramps over the bars before its window, the overlap stays on it', () => {
  const v = planHotMixSeam({ ...pair(120, 125), window: { aStartSec: aBar(101), bEntrySec: 0.2 + 56 * 4 * 60 / 125 } });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.plan.kind, 'split');
  // The ramp ends, in output time, on the window's downbeat; the cut is 8 bars on.
  const prof = profileOf(null, v.plan.aEnd);
  assert.ok(Math.abs(outAt(prof, aBar(101)) - (v.plan.aEnd!.fromSec + v.plan.aEnd!.rampSec)) < 1e-3);
  assert.ok(Math.abs(v.plan.outCueSec - aBar(109)) < 1e-3);
  assert.equal(v.plan.bPunchSec, v.plan.leadSec);
});

test('a phrase window the grids do not hold is no windowed seam', () => {
  const window = { aStartSec: aBar(101), bEntrySec: bBar(57) };
  // Off a downbeat.
  for (const w of [{ ...window, aStartSec: window.aStartSec + 1 }, { ...window, bEntrySec: window.bEntrySec + 0.1 }]) {
    const v = planHotMixSeam({ ...pair(120, 123), window: w });
    assert.equal(v.ok, false, JSON.stringify(w));
    assert.match((v as { reason: string }).reason, /phrase window/);
  }
  // The cut past A's end.
  assert.equal(planHotMixSeam({ ...pair(120, 123, { a: { ...grid(120), cueInSec: 0, endSec: aBar(108), start: null } }), window }).ok, false);
  // A's window on an untrusted (double-time) stretch of its grid.
  const a = {
    bpm: 120, beatsPerBar: 4,
    segments: [
      { anchorMs: 500, periodUs: 500000, beats: 380, downbeatMs: 500 },
      { anchorMs: 190500, periodUs: 250000, beats: 400, downbeatMs: 190500 },
    ],
  };
  assert.equal(planHotMixSeam({ ...pair(120, 123, { a: { ...a, cueInSec: 0, endSec: 240, start: null } }), window }).ok, false);
  // B an octave away: its bars are not A's, so its kick would miss the cut.
  const half = planHotMixSeam({ ...pair(124, 62), window: { aStartSec: 0.5 + 100 * 4 * 60 / 124, bEntrySec: 0.2 + 56 * 4 * 60 / 62 } });
  assert.equal(half.ok, false);
  assert.match((half as { reason: string }).reason, /octave/);
});

test('a phrase window on two-beat grids: the structure\'s four-beat bars are pairs of grid bars', () => {
  const two = (bpm: number, anchor: number) => ({ ...grid(bpm, anchor), beatsPerBar: 2 });
  const input: SeamInput = {
    stepPct: 3,
    a: { ...two(120, 0.5), cueInSec: 0, endSec: 240, start: null },
    b: { ...two(123, 0.2), cueInSec: 0, durationSec: 300 },
    window: { aStartSec: aBar(101), bEntrySec: bBar(57) },
  };
  const v = planHotMixSeam(input);
  assert.ok(v.ok, JSON.stringify(v));
  assert.ok(Math.abs(v.plan.outCueSec - aBar(109)) < 1e-3);
  assert.ok(Math.abs(v.plan.inCueSec - bBar(57)) < 1e-3);
  assert.equal(v.plan.bPunchSec, v.plan.leadSec);
});

// The punch moves with B's audio: a beat-phase shift that starts B later in
// its file brings the first hard kick that much earlier after B starts, at B's
// opening tempo; a shift the cue could not take (waitSec) is waited in the
// mixer, so it counts the other way. The mixer then takes its own cue-in
// landing off in B's time (radio.liq, HOT MIX BASS MOVE).
test('the punch follows the cue-in a beat-phase shift moved', () => {
  // 16 s planned at r = 0.975, cue moved 15 ms later in the file: the kick
  // comes 15 / 0.975 ms sooner.
  assert.equal(punchAfterShift(16, 100, 100.015, 0, 0.975), round4(16 - 0.015 / 0.975));
  // Moved earlier: later.
  assert.equal(punchAfterShift(16, 100, 99.98, 0, 1), 16.02);
  // Clamped at the file's start: the cue is 0, the wait holds B back 20 ms of
  // file, the same as a cue at -0.02.
  assert.equal(punchAfterShift(16, 0, 0, 0.02, 1), 16.02);
  // No shift: the plan's own.
  assert.equal(punchAfterShift(16, 100, 100, 0, 0.98), 16);
});
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
