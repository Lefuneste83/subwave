// The grid's bars decision (music/grid-policy.ts gridDecision), pure.
//
// Why this is pinned:
//   - Beat This! often reads beat 1 and beat 3 alternately in the body of a
//     4/4 track, so the downbeats split between two phases half a bar apart and
//     the single-phase agreement falls under the gate although the tempo grid
//     is excellent. The bars are also trusted when nearly every downbeat sits
//     on that half-bar pair (half-bar >= 0.9) AND the first and the last 32
//     bars each agree on ONE phase, the same one (edges >= 0.75): the edges
//     are what a transition uses.
//   - A grid measured before the worker reported those two numbers (both
//     null) decides exactly as before: the single-phase rule alone, and the
//     same held message.
// Run: `npm test -- grid-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_WRITE_GATE, gridDecision } from '../src/music/grid-policy.js';

const base = {
  status: 'ok' as const, bpm: 124, beatsPerBar: 4, decodedMs: 340_000, coverage: 0.97,
  segments: [{ anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 }],
  downbeatAgreement: 0.84,
};

test('the thresholds are the worker\'s (analyze_worker GRID_MIN_HALFBAR / GRID_MIN_EDGE_AGREEMENT)', () => {
  assert.equal(GRID_WRITE_GATE.minHalfbar, 0.9);
  assert.equal(GRID_WRITE_GATE.minEdgeAgreement, 0.75);
  assert.equal(GRID_WRITE_GATE.minDownbeatAgreement, 0.75);
});

test('fields absent or null: the single-phase rule exactly as before', () => {
  assert.equal(gridDecision(base).bars, true);
  assert.deepEqual(gridDecision({ ...base, downbeatHalfbar: null, downbeatEdgeAgreement: null }), gridDecision(base));
  const held = gridDecision({ ...base, downbeatAgreement: 0.53 });
  assert.equal(held.bpm, true);
  assert.equal(held.bars, false);
  assert.deepEqual(held.held, ['bars: downbeat agreement 0.53'], 'the old message, unchanged');
  assert.deepEqual(gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: null, downbeatEdgeAgreement: null }), held);
});

test('a half-bar split rescued by agreeing edges', () => {
  const d = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatEdgeAgreement: 0.9 });
  assert.equal(d.bars, true);
  assert.deepEqual(d.held, []);
  // At the thresholds exactly.
  assert.equal(gridDecision({ ...base, downbeatAgreement: 0.5, downbeatHalfbar: 0.9, downbeatEdgeAgreement: 0.75 }).bars, true);
  // A passing single phase stays passing whatever the edges say.
  assert.equal(gridDecision({ ...base, downbeatHalfbar: 0.5, downbeatEdgeAgreement: 0 }).bars, true);
});

test('not rescued: edges disagree, half-bar low, or only one of the two known', () => {
  const edges = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatEdgeAgreement: 0 });
  assert.equal(edges.bars, false);
  assert.deepEqual(edges.held, ['bars: downbeat agreement 0.53, half-bar 0.98, edges 0.00']);
  const half = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.8, downbeatEdgeAgreement: 0.9 });
  assert.equal(half.bars, false);
  assert.deepEqual(half.held, ['bars: downbeat agreement 0.53, half-bar 0.80, edges 0.90']);
  const one = gridDecision({ ...base, downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatEdgeAgreement: null });
  assert.equal(one.bars, false);
  assert.deepEqual(one.held, ['bars: downbeat agreement 0.53, half-bar 0.98, edges n/a']);
});

test('the rescue never bypasses the BPM gate, the metre or a placed downbeat', () => {
  const rescue = { downbeatAgreement: 0.53, downbeatHalfbar: 0.98, downbeatEdgeAgreement: 0.9 };
  assert.equal(gridDecision({ ...base, ...rescue, coverage: 0.5 }).bars, false);
  assert.equal(gridDecision({ ...base, ...rescue, beatsPerBar: null }).bars, false);
  assert.equal(gridDecision({ ...base, ...rescue, segments: [{ ...base.segments[0], downbeatMs: null }] }).bars, false);
});
