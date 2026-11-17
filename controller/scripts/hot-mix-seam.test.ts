import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLIDE_SEC, OVERLAP_BEATS, RAMP_BEATS, SYNC_MAX_PCT,
  incomingStamps, outAt, planHotMixSeam, profileOf, shiftInCue, srcAt,
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
