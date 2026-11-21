import assert from 'node:assert/strict';
import test from 'node:test';
import { beatGridRows, type BeatGridCoverage, type BeatGridRow } from './beat-grid-coverage';

// Both rows, asserted present.
function both(c: BeatGridCoverage, off = false): [BeatGridRow, BeatGridRow] {
  const r = beatGridRows(c, off);
  assert.equal(r.length, 2);
  return r as [BeatGridRow, BeatGridRow];
}

const base: BeatGridCoverage = {
  gridWanted: true,
  gridAvailable: true,
  structureAvailable: true,
  gridMeasured: 300,
  gridDue: 100,
  structureMeasured: 150,
  structureDue: 150,
};

test('no rows without a Hot Mix show or any coverage, nor on an older controller', () => {
  assert.deepEqual(beatGridRows(null, false), []);
  assert.deepEqual(beatGridRows({}, false), []);
  assert.deepEqual(beatGridRows({ ...base, gridWanted: false, gridMeasured: 0, structureMeasured: 0 }, false), []);
  assert.deepEqual(beatGridRows({ gridWanted: false, gridMeasured: null, structureMeasured: null }, false), []);
});

test('a Hot Mix show shows both rows, measured against measured + due', () => {
  const [grid, structure] = both(base);
  assert.equal(grid.key, 'grid');
  assert.equal(grid.label, 'Beat grid · Hot Mix');
  assert.equal(grid.pct, 75);
  assert.equal(grid.status, '300 measured · 100 due · 75%');
  assert.match(grid.hint, /used by Hot Mix shows/i);
  assert.match(grid.hint, /measured by Start tagging/);
  assert.equal(structure.key, 'structure');
  assert.equal(structure.pct, 50);
  assert.match(structure.hint, /phrase mix/);
});

test('existing coverage keeps the rows with no Hot Mix show, and says nothing new is measured', () => {
  const rows = both({ ...base, gridWanted: false });
  for (const r of rows) assert.match(r.hint, /No show has Hot Mix on/);
});

test('the status reads the engine, the capability and an uncounted library', () => {
  assert.equal(both(base, true)[0].status, 'engine off');
  assert.equal(both(base, true)[0].pct, null);
  const uncounted = both({ ...base, gridMeasured: null, gridDue: null, structureMeasured: null, structureDue: null });
  assert.equal(uncounted[0].status, 'not counted yet — press Re-count');
  assert.equal(uncounted[0].pct, null);
  const lean = both({ ...base, gridAvailable: false, structureAvailable: false });
  assert.match(lean[0].status, /can’t measure the beat grid/);
  assert.match(lean[0].status, /WITH_BEAT_GRID=1/);
  assert.match(lean[1].status, /can’t measure the structure/);
  // Nothing due at all: complete.
  assert.equal(both({ ...base, gridDue: 0 }, false)[0].pct, 100);
  assert.equal(both({ ...base, gridMeasured: 0, gridDue: 0 }, false)[0].pct, null);
  assert.equal(both({ ...base, gridMeasured: 0, gridDue: 0 }, false)[0].status, '0 measured · 0 due');
});
