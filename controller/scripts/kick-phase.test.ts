import assert from 'node:assert/strict';
import test from 'node:test';
import { KICK_SR, TEMPLATE_MIN_CORR, beatTemplate, relativePhase } from '../src/music/kick-phase.js';

// A kick: a 55 Hz sine decaying over 90 ms, with a 3 ms attack.
function kicks(beats: number[], offsetSec: number, lengthSec: number, { noise = 0 } = {}): Int16Array {
  const pcm = new Float64Array(Math.round(lengthSec * KICK_SR));
  for (const b of beats) {
    const at = Math.round((b + offsetSec) * KICK_SR);
    for (let i = 0; i < 0.09 * KICK_SR; i++) {
      const t = i / KICK_SR;
      const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.03);
      if (at + i >= 0 && at + i < pcm.length) pcm[at + i] += 12000 * env * Math.sin(2 * Math.PI * 55 * t);
    }
  }
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 - 0.5; };
  return Int16Array.from(pcm, (x) => Math.max(-32768, Math.min(32767, Math.round(x + noise * rnd()))));
}
const grid = (from: number, period: number, n: number) => Array.from({ length: n }, (_, k) => from + k * period);

test('the averaged beats of two kick tracks give their offset, in beats', () => {
  const pa = 0.5; const pb = 0.48;
  const a = grid(1, pa, 33);
  const b = grid(1, pb, 33);
  // A's kicks 5 ms after its grid, B's 35 ms after its own: B sits 30 ms later.
  const ta = beatTemplate(kicks(a, 0.005, 20, { noise: 2000 }), KICK_SR, 0, a)!;
  const tb = beatTemplate(kicks(b, 0.035, 20, { noise: 2000 }), KICK_SR, 0, b)!;
  const rel = relativePhase(ta, tb)!;
  assert.ok(rel, 'alike enough to align');
  assert.ok(rel.corr >= TEMPLATE_MIN_CORR);
  // The lag is in beats of each side's own grid: 35/480 - 5/500 of a beat.
  const want = 0.035 / pb - 0.005 / pa;
  assert.ok(Math.abs(rel.beats - want) < 0.004, `${rel.beats} vs ${want}`);
  // Moved by that many of B's beats, B's kick meets A's: the queue's shift.
  assert.ok(Math.abs(rel.beats * pb - (0.035 - 0.005 * pb / pa)) < 0.002);
});

test('kicks a little early read negative', () => {
  const a = grid(1, 0.5, 33);
  const ta = beatTemplate(kicks(a, 0.02, 20), KICK_SR, 0, a)!;
  const tb = beatTemplate(kicks(a, 0.0, 20), KICK_SR, 0, a)!;
  const rel = relativePhase(ta, tb)!;
  assert.ok(Math.abs(rel.beats * 0.5 + 0.02) < 0.002, `${rel.beats * 0.5}`);
});

test('beats too unlike to compare, or too few of them, align on the grids', () => {
  const a = grid(1, 0.5, 33);
  const ta = beatTemplate(kicks(a, 0, 20), KICK_SR, 0, a)!;
  // Noise with no beat in it.
  const flat = beatTemplate(kicks([], 0, 20, { noise: 8000 }), KICK_SR, 0, a);
  assert.ok(flat == null || relativePhase(ta, flat) == null);
  // Eight beats are the floor.
  assert.equal(beatTemplate(kicks(a, 0, 20), KICK_SR, 0, a.slice(0, 5)), null);
  // Silence is flat: nothing to align on.
  assert.equal(beatTemplate(new Int16Array(20 * KICK_SR), KICK_SR, 0, a), null);
});
