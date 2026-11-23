// Which whole-file reads keep the sidecar's run copy (music/stage-policy.ts).
// Run: `npm test -- stage-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { stageKeep, stageKey } from '../src/music/stage-policy.js';

test('the lead loudness + edges read keeps the copy only for a track whose grid is due', () => {
  assert.equal(stageKeep('lead', { gridDue: true, structureCapable: false }), true);
  assert.equal(stageKeep('lead', { gridDue: false, structureCapable: true }), false);
});

test('the grid read keeps the copy only when a structure can follow', () => {
  assert.equal(stageKeep('grid', { gridDue: false, structureCapable: true }), true);
  assert.equal(stageKeep('grid', { gridDue: true, structureCapable: false }), false);
});

test('the structure and the backlog slice never keep a copy (last read, read once)', () => {
  for (const step of ['structure', 'rest'] as const) {
    for (const gridDue of [true, false]) {
      for (const structureCapable of [true, false]) assert.equal(stageKeep(step, { gridDue, structureCapable }), false);
    }
  }
});

test('a copy is keyed under its run token, so the run releases its copies by prefix', () => {
  assert.equal(stageKey('tok', 'abc'), 'tok/abc');
  assert.ok(stageKey('tok', 'abc').startsWith('tok/'));
});
