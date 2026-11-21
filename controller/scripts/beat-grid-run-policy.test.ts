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
//   - an analyzer that says no, or has not said, gets one notice naming what
//     was skipped and why;
//   - the step order puts the tracks this run just analysed first.
// Run: `npm test -- beat-grid-run-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { beatGridRunDecision, newTracksFirst } from '../src/music/beat-grid-run-policy.js';

const CAPS = [true, false, null] as const;

test('without a Hot Mix show nothing is planned and nothing is said', () => {
  for (const gridCapable of CAPS) for (const structureCapable of CAPS) {
    assert.deepEqual(beatGridRunDecision({ hotMix: false, gridCapable, structureCapable }), { grid: false, structure: false, notice: null });
  }
});

test('with Hot Mix and a capable analyzer both steps run, silently', () => {
  assert.deepEqual(beatGridRunDecision({ hotMix: true, gridCapable: true, structureCapable: true }), { grid: true, structure: true, notice: null });
});

test('each step needs a positive answer; the structure runs on stored grids without grid capability', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: false, structureCapable: true });
  assert.equal(d.grid, false);
  assert.equal(d.structure, true);
  assert.match(d.notice ?? '', /Hot Mix/);
  assert.match(d.notice ?? '', /beat grid/);
  assert.match(d.notice ?? '', /cannot/);
  assert.match(d.notice ?? '', /WITH_BEAT_GRID=1/);
  assert.match(d.notice ?? '', /grids already stored/);
  assert.doesNotMatch(d.notice ?? '', /measure the track structure/, 'the structure step ran: not named as skipped');

  const s = beatGridRunDecision({ hotMix: true, gridCapable: true, structureCapable: false });
  assert.deepEqual([s.grid, s.structure], [true, false]);
  assert.match(s.notice ?? '', /cannot measure the track structure/);
  assert.doesNotMatch(s.notice ?? '', /beat grid/);
});

test('an analyzer that has not said is skipped and asked again next run', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: null, structureCapable: null });
  assert.deepEqual([d.grid, d.structure], [false, false]);
  assert.match(d.notice ?? '', /has not said whether it can measure the beat grid or the track structure/);
  assert.match(d.notice ?? '', /asked again next run/);
  assert.doesNotMatch(d.notice ?? '', /cannot/);
});

test('one notice covers a refusal and an unknown answer together', () => {
  const d = beatGridRunDecision({ hotMix: true, gridCapable: false, structureCapable: null });
  assert.deepEqual([d.grid, d.structure], [false, false]);
  assert.match(d.notice ?? '', /cannot measure the beat grid/);
  assert.match(d.notice ?? '', /has not said whether it can measure the track structure/);
  assert.doesNotMatch(d.notice ?? '', /grids already stored/, 'the structure did not run either');
});

test('newTracksFirst: the run\'s own tracks lead, in their order, then the rest, each id once', () => {
  assert.deepEqual(newTracksFirst(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(newTracksFirst(['a', 'b'], []), ['a', 'b']);
});
