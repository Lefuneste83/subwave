import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ON_BEAT_SEC, PEAK_MIN_SHARE, PHASE_SR, SHIFT_MAX_SEC, beatOffset, percussionPhase, type BeatOffset,
} from '../src/music/percussion-phase.js';

// High-passed percussion: a hat, a 6 ms burst of noise with a 1 ms attack,
// `offsetSec` after each beat, plus optional hats on the offbeat and a noise
// floor. (The decode high-passes; these signals are already treble.)
function hats(beats: number[], offsetSec: number, lengthSec: number, { offbeat = 0, onbeat = 1, noise = 0, period = 0.5 } = {}): Int16Array {
  const pcm = new Float64Array(Math.round(lengthSec * PHASE_SR));
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 - 0.5; };
  const hit = (at: number, gain: number) => {
    const i0 = Math.round(at * PHASE_SR);
    for (let i = 0; i < 0.006 * PHASE_SR; i++) {
      const t = i / PHASE_SR;
      const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.002);
      if (i0 + i >= 0 && i0 + i < pcm.length) pcm[i0 + i] += gain * 20000 * env * rnd();
    }
  };
  for (const b of beats) {
    if (onbeat) hit(b + offsetSec, onbeat);
    if (offbeat) hit(b + period / 2 + offsetSec, offbeat);
  }
  return Int16Array.from(pcm, (x) => Math.max(-32768, Math.min(32767, Math.round(x + noise * rnd()))));
}
const grid = (from: number, period: number, n: number) => Array.from({ length: n }, (_, k) => from + k * period);
const near = (got: number, want: number, tol = 0.0015) => assert.ok(Math.abs(got - want) < tol, `${got} vs ${want}`);

test('the on-beat percussion is found where it sits against the grid, early or late', () => {
  const g = grid(1, 0.5, 32);
  for (const off of [-0.024, -0.009, 0, 0.012, 0.03]) {
    const o = beatOffset(hats(g, off, 18, { noise: 1500, offbeat: 0.8 }), PHASE_SR, 0, g)!;
    near(o.offsetSec, off);
    assert.ok(o.share >= PEAK_MIN_SHARE, `share ${o.share}`);
  }
});

test('B late against A moves its cue-in later by the lateness in its own file seconds', () => {
  // The seam the operator heard 18 ms off: Voices -> Dancing Alone, percussion
  // -24 ms on A's grid and -9 on B's: B's lands 15 ms after A's.
  const a: BeatOffset = { offsetSec: -0.0239, share: 0.92, beats: 32 };
  const b: BeatOffset = { offsetSec: -0.0087, share: 0.98, beats: 32 };
  const v = percussionPhase(a, b, 1.01637);
  assert.ok(v.ok);
  near(v.lateSec, -0.0087 / 1.01637 + 0.0239, 1e-5);
  near(v.cueShiftSec, v.lateSec * 1.01637, 1e-5);
  // B early: the cue-in moves earlier (negative), which shiftInCue may turn into a wait.
  const early = percussionPhase(b, a, 1);
  assert.ok(early.ok && early.cueShiftSec < 0);
  // A ramping on a split seam reads its offset at its own closing tempo.
  const split = percussionPhase(a, b, 0.98, 1.02);
  assert.ok(split.ok);
  near(split.lateSec, -0.0087 / 0.98 + 0.0239 / 1.02, 1e-5);
});

test('anything unclear stays grid on grid', () => {
  const ok: BeatOffset = { offsetSec: 0.005, share: 0.95, beats: 32 };
  assert.match((percussionPhase(null, ok, 1) as { reason: string }).reason, /no outgoing beats/);
  assert.match((percussionPhase(ok, { ...ok, share: 0.2 }, 1) as { reason: string }).reason, /no clear on-beat percussion in the incoming/);
  assert.match((percussionPhase({ ...ok, offsetSec: ON_BEAT_SEC + 0.01 }, ok, 1) as { reason: string }).reason, /outgoing track's percussion is off the beat/);
  const far = percussionPhase({ ...ok, offsetSec: -0.025 }, { ...ok, offsetSec: 0.025 }, 1);
  assert.ok(!far.ok && /past the 30 ms cap/.test(far.reason), JSON.stringify(far));
  assert.equal(SHIFT_MAX_SEC, 0.03);
});

test('offbeat-only percussion has no on-beat point, and silence or too few beats measure nothing', () => {
  const g = grid(1, 0.5, 32);
  // Hats only on the offbeat: the fold's peak is a quarter of a beat out, past ON_BEAT_SEC.
  const off = beatOffset(hats(g, 0, 18, { onbeat: 0, offbeat: 1, period: 0.5 }), PHASE_SR, 0, g);
  assert.ok(off == null || Math.abs(off.offsetSec) > ON_BEAT_SEC || off.share < 0.5, JSON.stringify(off));
  assert.equal(beatOffset(new Int16Array(18 * PHASE_SR), PHASE_SR, 0, g), null);
  assert.equal(beatOffset(hats(g, 0, 18), PHASE_SR, 0, g.slice(0, 5)), null);
});
