// The rule deciding whether a regular run (the GUI's Start tagging / Analyze
// audio) also measures the opt-in beat grid and structure facets
// (music/beat-grid-run-policy.ts). Pure.
//
// Pinned here:
//   - nothing is planned and nothing is said without a Hot Mix show, whatever
//     the analyzer reports (a station without Hot Mix stays byte-identical);
//   - with Hot Mix, each step needs the analyzer's POSITIVE answer (unknown is
//     never planned, the planner's own rule for both facets);
//   - the structure runs without grid capability (it measures the grids
//     already stored);
//   - an analyzer that says no, or has not said, gives each skipped step its
//     reason, for the step's skip line in the run log;
//   - the step order puts the tracks this run just analysed first.
// Run: `npm test -- beat-grid-run-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { beatGridRunDecision, newTracksFirst } from '../src/music/beat-grid-run-policy.js';

const CAPS = [true, false, null] as const;

test('without a Hot Mix show nothing is planned and nothing is said', () => {
  for (const gridCapable of CAPS) for (const structureCapable of CAPS) {
    assert.deepEqual(beatGridRunDecision({ hotMix: false, gridCapable, structureCapable }), { grid: false, structure: false, reasons: {} });
  }
});

test('with Hot Mix and a capable analyzer both steps run, silently', () => {
  assert.deepEqual(beatGridRunDecision({ hotMix: true, gridCapable: true, structureCapable: true }), { grid: true, structure: true, reasons: {} });
});

test('each step needs a positive answer; the structure runs on stored grids without grid capability', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: false, structureCapable: true });
  assert.equal(d.grid, false);
  assert.equal(d.structure, true);
  assert.match(d.reasons.grid ?? '', /cannot measure it/);
  assert.match(d.reasons.grid ?? '', /WITH_BEAT_GRID=1/);
  assert.equal(d.reasons.structure, undefined, 'the structure step ran: no skip reason');

  const s = beatGridRunDecision({ hotMix: true, gridCapable: true, structureCapable: false });
  assert.deepEqual([s.grid, s.structure], [true, false]);
  assert.match(s.reasons.structure ?? '', /cannot measure it/);
  assert.doesNotMatch(s.reasons.structure ?? '', /WITH_BEAT_GRID/);
  assert.equal(s.reasons.grid, undefined);
});

test('an analyzer that has not said is skipped and asked again next run', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: null, structureCapable: null });
  assert.deepEqual([d.grid, d.structure], [false, false]);
  for (const r of [d.reasons.grid, d.reasons.structure]) {
    assert.match(r ?? '', /has not said whether it can measure it/);
    assert.match(r ?? '', /asked again next run/);
    assert.doesNotMatch(r ?? '', /cannot/);
  }
});

test('a refusal and an unknown answer each get their own reason', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: false, structureCapable: null });
  assert.deepEqual([d.grid, d.structure], [false, false]);
  assert.match(d.reasons.grid ?? '', /cannot measure it/);
  assert.match(d.reasons.structure ?? '', /has not said/);
});

test('newTracksFirst: the run\'s own tracks lead, in their order, then the rest, each id once', () => {
  assert.deepEqual(newTracksFirst(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(newTracksFirst(['a', 'b'], []), ['a', 'b']);
});
