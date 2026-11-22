// The grid's bars decision (music/grid-policy.ts gridDecision), pure.
//
// Why this is pinned:
//   - Beat This! often reads beat 1 and beat 3 alternately in the body of a
//     4/4 track, so the downbeats split between two phases half a bar apart and
//     the single-phase agreement falls under the gate although the tempo grid
//     is excellent. The bars are also trusted when nearly every downbeat sits
//     on that half-bar pair (half-bar >= 0.9): the worker has already chosen
//     which half is the bar line (the drop, else the majority), so the policy
//     only decides trust, and the drop's figures never gate it.
//   - A grid measured before the worker reported the half-bar share (null)
//     decides exactly as before: the single-phase rule alone, and the same
//     held message.
// Run: `npm test -- grid-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_WRITE_GATE, gridDecision } from '../src/music/grid-policy.js';

const base = {
  status: 'ok' as const, bpm: 124, beatsPerBar: 4, decodedMs: 340_000, coverage: 0.97,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  downbeatAgreement: 0.84,
};

test('the thresholds are the worker\'s (analyze_worker GRID_MIN_HALFBAR / GRID_MIN_DOWNBEAT_AGREEMENT)', () => {
  assert.equal(GRID_WRITE_GATE.minHalfbar, 0.9);
  assert.equal(GRID_WRITE_GATE.minDownbeatAgreement, 0.75);
});

test('half-bar absent or null: the single-phase rule exactly as before', () => {
  assert.equal(gridDecision(base).bars, true);
  assert.deepEqual(gridDecision({ ...base, downbeatHalfbar: null }), gridDecision(base));
  const held = gridDecision({ ...base, downbeatAgreement: 0.53 });
  assert.equal(held.bpm, true);
  assert.equal(held.bars, false);
  assert.deepEqual(held.held, ['bars: downbeat agreement 0.53'], 'the old message, unchanged');
  assert.deepEqual(gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: null }), held);
  assert.deepEqual(gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: undefined }), held);
});

test('a half-bar split at or over 0.9 has trusted bars when a clear drop placed its bar line', () => {
  const drop = { downbeatPhase: 'drop' as const, downbeatDropDb: 22.6 };
  const d = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, ...drop });
  assert.equal(d.bars, true);
  assert.deepEqual(d.held, []);
  // At both thresholds exactly.
  assert.equal(gridDecision({ ...base, downbeatAgreement: 0.5, downbeatHalfbar: 0.9, downbeatPhase: 'drop', downbeatDropDb: 15 }).bars, true);
  // A passing single phase stays passing whatever the half-bar share says.
  assert.equal(gridDecision({ ...base, downbeatHalfbar: 0.5 }).bars, true);
});

test('a half-bar split left on the majority, or on a weak drop, keeps its bars held', () => {
  const majority = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatPhase: 'majority', downbeatDropDb: null });
  assert.equal(majority.bars, false);
  assert.deepEqual(majority.held, ['bars: downbeat agreement 0.53, half-bar 0.98, no clear drop']);
  const weak = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatPhase: 'drop', downbeatDropDb: 11.6 });
  assert.equal(weak.bars, false);
  assert.deepEqual(weak.held, ['bars: downbeat agreement 0.53, half-bar 0.98, drop 11.6 dB']);
  // A share with no placement reported is not trusted either.
  assert.equal(gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98 }).bars, false);
});

test('not rescued under 0.9: the held message names both scores', () => {
  const half = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.89, downbeatPhase: 'drop', downbeatDropDb: 30 });
  assert.equal(half.bars, false);
  assert.deepEqual(half.held, ['bars: downbeat agreement 0.53, half-bar 0.89, drop 30 dB']);
});

test('the rescue never bypasses the BPM gate, the metre or a placed downbeat', () => {
  const rescue = { downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatPhase: 'drop' as const, downbeatDropDb: 22.6 };
  const lowCoverage = gridDecision({ ...base, ...rescue, coverage: 0.5 });
  assert.equal(lowCoverage.bpm, false);
  assert.equal(lowCoverage.bars, false);
  assert.equal(gridDecision({ ...base, ...rescue, bpm: 240 }).bars, false);
  assert.equal(gridDecision({ ...base, ...rescue, beatsPerBar: null }).bars, false);
  assert.equal(gridDecision({ ...base, ...rescue, segments: [{ ...base.segments[0], downbeatMs: null }] }).bars, false);
});
