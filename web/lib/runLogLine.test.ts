// The run log's lines in the Library page's log box (lib/runLogLine.ts): a
// line of the controller's run log carries its own mark, so the panel adds no
// emoji for its kind, and an older plain event still gets one.
//
// Run: `npm test -- lib/runLogLine`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carriesOwnMark, isRunLogHeading } from './runLogLine';

test('a run-log line carries its own mark or indentation', () => {
  for (const line of [
    '━━ Tagging run · 9 steps',
    '▶ [3/9] Measure loudness and silence at both ends',
    '    Runs on : analyzer at analyzer.local:8080 · CPU lane, 12 at a time',
    '  … 25/29 done',
    '✔ [3/9] Measure loudness and silence at both ends — 29 done, 0 failed · 37 s',
    '⚠ [4/9] Find the intro — 27 done, 2 failed · 1 min 4 s',
    '✖ Stems not saved: the analyzer cannot see the stems share.',
    '▷ [5/9] Separate stems for blends — skipped: nothing missing',
    '■ Finished in 4 min 11 s',
  ]) assert.equal(carriesOwnMark(line), true, line);
  assert.equal(carriesOwnMark('Scanned 74,725 tracks'), false, 'an older plain event keeps its kind emoji');
});

test('headers and the opening and closing lines are headings; detail is not', () => {
  assert.equal(isRunLogHeading('▶ [3/9] Measure loudness'), true);
  assert.equal(isRunLogHeading('━━ Tagging run · 9 steps'), true);
  assert.equal(isRunLogHeading('■ Finished in 4 min 11 s'), true);
  assert.equal(isRunLogHeading('    Runs on : analyzer'), false);
  assert.equal(isRunLogHeading('✔ [3/9] done'), false);
});
