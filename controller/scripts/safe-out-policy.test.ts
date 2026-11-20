// The DJ Hot Mix safe transition's placement (music/safe-out-policy.ts): the
// outgoing track cut one bar after one of its bar lines, the incoming track's
// first downbeat on that bar line, two bars buffered before it, where the
// mixer once rode the bass out (now one quick pot cut at the line). Chosen by
// blind set 5 (bass-out acceptable 3/3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSafeOut, safeCrossSec, PRE_ROLL_SEC, FALLBACK_BAR_SEC } from '../src/music/safe-out-policy.js';

// One trusted segment at `bpm`, beats from `anchor`, a downbeat on the first beat.
const grid = (bpm: number, anchor = 0.5, beats = 600) => ({
  bpm, beatsPerBar: 4,
  segments: [{ anchorMs: anchor * 1000, periodUs: 60e6 / bpm, beats, downbeatMs: anchor * 1000 }],
});
const near = (x: number, y: number, eps = 1e-3) => assert.ok(Math.abs(x - y) < eps, `${x} vs ${y}`);

test('on a grid: the latest bar line one bar before the end, the incoming downbeat on it', () => {
  const bar = 4 * 60 / 120; // 2 s
  const p = planSafeOut({ a: { ...grid(120, 0.5), endSec: 200.9 }, b: { ...grid(134, 1.2), cueInSec: 0.4 } });
  assert.ok(p);
  assert.equal(p.source, 'grid');
  near(p.barSec, bar);
  // bar lines at 0.5 + 2k; the latest with a bar after it before 200.9 is 198.5
  near(p.entrySec, 198.5);
  near(p.outCueSec, 200.5);
  // the incoming downbeat at 1.2 s, started PRE_ROLL_SEC before it
  near(p.inCueSec!, 1.2 - PRE_ROLL_SEC);
  near(p.leadSec, bar + PRE_ROLL_SEC);
  near(safeCrossSec(p), 3 * bar + PRE_ROLL_SEC);
});

test('the pre-roll never reaches before the incoming cue-in', () => {
  const p = planSafeOut({ a: { ...grid(120), endSec: 200 }, b: { ...grid(128, 0.55), cueInSec: 0.5 } });
  near(p!.inCueSec!, 0.5);
  near(p!.leadSec, p!.barSec + 0.05);
});

test('no incoming downbeat within 30 s, or no incoming side: the incoming keeps its cue', () => {
  const far = planSafeOut({ a: { ...grid(120), endSec: 200 }, b: { ...grid(128, 40), cueInSec: 0 } });
  assert.equal(far!.inCueSec, null);
  near(far!.leadSec, far!.barSec);
  const coast = planSafeOut({ a: { ...grid(120), endSec: 200 } });
  assert.equal(coast!.inCueSec, null);
});

test('no outgoing grid: the bar from the tempo tag, folded, the bar line a bar before the end', () => {
  const tag = planSafeOut({ a: { bpm: 62, endSec: 180 } });
  assert.equal(tag!.source, 'tempo tag');
  near(tag!.barSec, 4 * 60 / 124);
  near(tag!.outCueSec, 180);
  const none = planSafeOut({ a: { endSec: 180 } });
  assert.equal(none!.source, 'fallback');
  near(none!.barSec, FALLBACK_BAR_SEC);
  near(none!.entrySec, 178);
});

test('the ride stays inside the track; a track too short for it gets no plan', () => {
  assert.equal(planSafeOut({ a: { endSec: 5 } }), null);
  assert.equal(planSafeOut({ a: { endSec: 0 } }), null);
  // a grid whose bar lines all sit too close to the cue-in falls back to the tag
  const p = planSafeOut({ a: { ...grid(120, 0.5, 8), endSec: 120, cueInSec: 0 } });
  assert.equal(p!.source, 'tempo tag');
});
