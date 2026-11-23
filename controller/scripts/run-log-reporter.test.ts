// The run log's reporter (music/run-log.ts) and the event channel under it
// (tagger-progress.ts): each line is emitted ONCE, as the event sentinel when
// the controller reads the child's stdout, as the plain line from a shell. A
// plain echo before each sentinel was the source of every doubled line in the
// admin's run log. Also pins the step numbering a run's banner promises.
//
// Run: npm test -- run-log-reporter

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { EVENT_PREFIX, MANAGED_ENV } from '../src/music/tagger-progress.js';
import { progress as runlogProgress, resetRunLog, setRunLogSink } from '../src/music/run-log.js';

function capture(managed: boolean, fn: () => void): string[] {
  const lines: string[] = [];
  const log = console.log;
  const before = process.env[MANAGED_ENV];
  if (managed) process.env[MANAGED_ENV] = '1';
  else delete process.env[MANAGED_ENV];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { fn(); } finally {
    console.log = log;
    if (before === undefined) delete process.env[MANAGED_ENV];
    else process.env[MANAGED_ENV] = before;
  }
  return lines;
}

afterEach(() => setRunLogSink(null));

test('under the controller a step emits only event sentinels, one per line', () => {
  const lines = capture(true, () => {
    const r = resetRunLog();
    r.plan('Tagging run', [{ id: 'walk', title: 'Read the music library' }], ['Navidrome at music.local']);
    const s = r.step('walk').start({ runsOn: 'Navidrome at music.local', scope: 'the whole library' });
    s.progress(500, 1000);
    s.done({ done: 1000, failed: 0 });
  });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(l.startsWith(EVENT_PREFIX), `a plain echo leaked: ${l}`);
  const texts = lines.map(l => JSON.parse(l.slice(EVENT_PREFIX.length)).text as string);
  assert.equal(new Set(texts).size, texts.length, `a line was emitted twice:\n${texts.join('\n')}`);
  assert.ok(texts.includes('▶ [1/1] Read the music library'));
  assert.ok(texts.some(t => /^✔ \[1\/1\] Read the music library — 1,000 done, 0 failed · \d+ s$/.test(t)), texts.join('\n'));
  const result = lines.map(l => JSON.parse(l.slice(EVENT_PREFIX.length))).find(e => e.text.startsWith('✔'));
  assert.equal(result.kind, 'success');
});

test('from a shell the same step prints only the plain lines, once each', () => {
  const lines = capture(false, () => {
    const r = resetRunLog();
    r.step('walk', 'Read the music library').start({ scope: 'x' });
    r.step('walk').done({ done: 1, failed: 0 });
  });
  assert.ok(lines.every(l => !l.startsWith(EVENT_PREFIX)), lines.join('\n'));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '▶ [1/1] Read the music library');
});

test('every planned step keeps its number, run or skipped, and the summary lists them all', () => {
  const out: Array<[string, string]> = [];
  setRunLogSink((kind, text) => out.push([kind, text]));
  const r = resetRunLog();
  r.plan('Tagging run', [
    { id: 'walk', title: 'Read the music library' },
    { id: 'stems', title: 'Separate stems for blends' },
    { id: 'grid', title: 'Beat grid for Hot Mix' },
  ], []);
  r.step('walk').done({ done: 3, failed: 0 });
  r.step('stems').skip('nothing missing');
  r.step('grid').start().done({ done: 0, failed: 2 });
  r.finish({ headline: '', library: '' });
  const texts = out.map(([, t]) => t);
  assert.equal(texts[0], '━━ Tagging run · 3 steps');
  assert.ok(texts.includes('▷ [2/3] Separate stems for blends — skipped: nothing missing'));
  assert.ok(texts.some(t => t.startsWith('✖ [3/3] Beat grid for Hot Mix — 0 done, 2 failed')));
  assert.equal(out.find(([, t]) => t.startsWith('✖ [3/3]'))![0], 'error');
  assert.ok(texts.includes('      ▷ [2] Separate stems for blends · skipped'), texts.join('\n'));
});

test('a problem is said once where it happens and once more in the summary list', () => {
  const out: string[] = [];
  setRunLogSink((_k, text) => out.push(text));
  const r = resetRunLog();
  r.step('x', 'Something').start();
  r.problem('error', 'Stems not saved: the analyzer cannot see the stems share.');
  r.finish({ headline: '', library: '' });
  assert.equal(out.filter(t => t === '✖ Stems not saved: the analyzer cannot see the stems share.').length, 1);
  assert.equal(out.filter(t => t === '      ✖ Stems not saved: the analyzer cannot see the stems share.').length, 1);
});

test('debug lines appear only when verbose', () => {
  const out: string[] = [];
  setRunLogSink((_k, text) => out.push(text));
  const r = resetRunLog();
  r.debug('batch=10 knnK=10');
  assert.deepEqual(out, []);
  r.verbose = true;
  r.debug('batch=10 knnK=10');
  assert.deepEqual(out, ['    batch=10 knnK=10']);
});

// A fake clock: the reporter reads time through `now`.
function clocked(): { r: ReturnType<typeof resetRunLog>; out: string[]; tick: (ms: number) => void } {
  const out: string[] = [];
  setRunLogSink((_k, text) => out.push(text));
  const r = resetRunLog();
  let t = 1_000_000;
  r.now = () => t;
  return { r, out, tick: (ms) => { t += ms; } };
}

test('a 74,725-track walk prints at most ten progress lines, 15 s apart or more', () => {
  const { r, out, tick } = clocked();
  const s = r.step('walk', 'Read the music library').start();
  for (let n = 500; n <= 74_725; n += 500) { tick(470); s.progressCount(n, 'tracks read', 74_725); }
  s.done({ summary: '74,725 tracks read' });
  const progress = out.filter(t => t.startsWith('  …'));
  assert.ok(progress.length >= 2 && progress.length <= 10, progress.join('\n'));
});

test('every step follows the same cap, whoever calls progress', () => {
  const { r, out, tick } = clocked();
  r.step('lane', 'Find the intro').start();
  for (let n = 1; n <= 240; n++) { tick(2_300); runlogProgress(n, 240); }
  r.step('lane').done({ done: 240, failed: 0 });
  const progress = out.filter(t => t.startsWith('  …'));
  assert.ok(progress.length >= 8 && progress.length <= 10, progress.join('\n'));
  assert.ok(!progress.includes('  … 240/240 done'), 'the result line says the last one');
});

test('a step reported after the fact gives its own work time and says it ran alongside', () => {
  const { r, out, tick } = clocked();
  r.plan('Tagging run', [{ id: 'selfcheck', title: 'Quality self-check' }], []);
  const at = r.now();
  tick(16 * 60_000);
  r.step('selfcheck').start({ at }).done({ summary: '150 tracks compared', ms: 3_000, alongside: 'the analysis' });
  r.finish({ headline: '', library: '' });
  assert.ok(out.includes('✔ [1/1] Quality self-check — 150 tracks compared · 3 s (ran alongside the analysis)'), out.join('\n'));
  assert.ok(out.includes('      ✔ [1] Quality self-check · 3 s (ran alongside the analysis)'), out.join('\n'));
});

test('the run tells the analysis steps where their tracks come from', () => {
  const r = resetRunLog();
  r.setOrigins({ new: ['a', 'b'], replaced: ['c'] });
  assert.deepEqual(r.originsOf(['a', 'b', 'c', 'd']), { new: 2, replaced: 1, other: 1 });
  assert.equal(resetRunLog().originsOf(['a']), undefined, 'a run that set none: no breakdown');
});
