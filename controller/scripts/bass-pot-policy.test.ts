// The DJ Hot Mix bass pots (music/bass-pot-policy.ts): the outgoing bass tamed
// over the last 8 bars, the incoming bass swapped in at the outgoing end.
// Chosen by blind set 8 (build acceptable 3/3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBassPots, BUILD_BARS, SWAP_SEC } from '../src/music/bass-pot-policy.js';

test('a 16-bar overlap: tamed over its last 8 bars, swapped at its end', () => {
  // 16 bars of 4 beats in 31.2 s: a 1.95 s bar
  const p = planBassPots({ leadSec: 31.2, overlapBeats: 64, beatsPerBar: 4 });
  assert.deepEqual(p, { buildSec: 15.6, punchSec: 31.2 });
});

test('an 8-bar overlap tames over all of it, short of the swap', () => {
  const p = planBassPots({ leadSec: 16, overlapBeats: 32, beatsPerBar: 4 });
  assert.equal(p!.punchSec, 16);
  assert.equal(p!.buildSec, 16 - SWAP_SEC);
});

test('bars follow the outgoing meter', () => {
  // 3/4: 48 beats are 16 bars, so 8 bars are half the overlap
  const p = planBassPots({ leadSec: 24, overlapBeats: 48, beatsPerBar: 3 });
  assert.equal(p!.buildSec, 12);
  assert.equal(BUILD_BARS, 8);
});

test('an unknown meter counts four beats a bar', () => {
  assert.equal(planBassPots({ leadSec: 32, overlapBeats: 64, beatsPerBar: 0 })!.buildSec, 16);
  assert.equal(planBassPots({ leadSec: 32, overlapBeats: 64, beatsPerBar: null })!.buildSec, 16);
});

test('an overlap that cannot hold the swap, or of unknown length, airs as it did', () => {
  assert.equal(planBassPots({ leadSec: 0.1, overlapBeats: 32, beatsPerBar: 4 }), null);
  assert.equal(planBassPots({ leadSec: Number.NaN, overlapBeats: 32, beatsPerBar: 4 }), null);
  assert.equal(planBassPots({ leadSec: 16, overlapBeats: 0, beatsPerBar: 4 }), null);
});
