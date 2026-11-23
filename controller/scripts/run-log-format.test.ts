// The run log's one wording module (music/run-log-format.ts): every phase of a
// tagging or analysis run states its task, where it runs and its scope in the
// same header block, reports progress and one result line, and says each
// problem in plain words with its cause and its fix. These pin the shapes.
//
// Run: npm test -- run-log-format

import assert from 'node:assert/strict';
import test from 'node:test';
import * as f from '../src/music/run-log-format.js';

test('a step header is one block: task, where it runs, scope', () => {
  assert.deepEqual(
    f.headerLines({
      n: 3, total: 9, title: 'Measure loudness and silence at both ends',
      runsOn: 'analyzer at analyzer.local:8080 · CPU lane, 12 at a time',
      scope: '29 tracks missing it, out of 74,725 in the library',
    }),
    [
      '▶ [3/9] Measure loudness and silence at both ends',
      '    Runs on : analyzer at analyzer.local:8080 · CPU lane, 12 at a time',
      '    Scope   : 29 tracks missing it, out of 74,725 in the library',
    ],
  );
  // A step with nothing to say about a machine or a scope leaves the line out.
  assert.deepEqual(f.headerLines({ n: 1, total: 2, title: 'Quality self-check' }), ['▶ [1/2] Quality self-check']);
});

test('a skipped step keeps its number and says why on one line', () => {
  assert.equal(
    f.skipLine({ n: 5, total: 9, title: 'Separate stems for blends', reason: 'nothing missing' }),
    '▷ [5/9] Separate stems for blends — skipped: nothing missing',
  );
});

test('progress is an indented n/N line, with no ok=/fail= jargon', () => {
  assert.equal(f.progressLine(25, 29), '  … 25/29 done');
  assert.equal(f.progressLine(1500, 74725), '  … 1,500/74,725 done');
});

test('the result line carries the outcome mark, the counts and the duration', () => {
  const base = { n: 3, total: 9, title: 'Measure loudness and silence at both ends' };
  assert.equal(
    f.resultLine({ ...base, outcome: 'ok', summary: f.countsSummary({ done: 29, failed: 0 }), ms: 37_000 }),
    '✔ [3/9] Measure loudness and silence at both ends — 29 done, 0 failed · 37 s',
  );
  assert.equal(
    f.resultLine({ ...base, outcome: 'partial', summary: f.countsSummary({ done: 27, failed: 2 }), ms: 64_000 }),
    '⚠ [3/9] Measure loudness and silence at both ends — 27 done, 2 failed · 1 min 4 s',
  );
  assert.equal(
    f.resultLine({ ...base, outcome: 'failed', summary: f.countsSummary({ done: 0, failed: 29 }), ms: 3_723_000 }),
    '✖ [3/9] Measure loudness and silence at both ends — 0 done, 29 failed · 1 h 2 min',
  );
});

test('the outcome follows the counts: no failure is ok, nothing done is failed', () => {
  assert.equal(f.outcomeOf({ done: 29, failed: 0 }), 'ok');
  assert.equal(f.outcomeOf({ done: 27, failed: 2 }), 'partial');
  assert.equal(f.outcomeOf({ done: 0, failed: 3 }), 'failed');
  assert.equal(f.outcomeOf({ done: 0, failed: 0 }), 'ok');
  // Tracks left for later are never a silent success.
  assert.equal(f.outcomeOf({ done: 0, failed: 0, left: 209 }), 'partial');
});

test('tracks left for later are counted with their reason, never a silent zero', () => {
  assert.equal(
    f.countsSummary({ done: 0, failed: 0, left: { count: 209, why: 'the stems share is missing on the analyzer' } }),
    '0 done, 0 failed, 209 left for later (the stems share is missing on the analyzer)',
  );
});

test('scope wording: missing out of the library, or per product', () => {
  assert.equal(f.scopeMissing({ missing: 29, pool: 74_725 }), '29 tracks missing it, out of 74,725 in the library');
  assert.equal(f.scopeMissing({ missing: 1, pool: 3, what: 'a beat grid' }), '1 track missing a beat grid, out of 3 in the library');
  assert.equal(
    f.scopeProducts({ tracks: 29, pool: 74_725, needs: [['intro, tempo and key', 29], ['outro', 29], ['sounds-like', 29], ['vocals', 0]] }),
    '29 of 74,725 tracks in the library — 29 need intro, tempo and key, 29 outro, 29 sounds-like',
  );
});

test('a host is named without credentials, path or query string', () => {
  assert.equal(f.hostOf('http://user:secret@analyzer.local:8080/x?auth=abc'), 'analyzer.local:8080');
  assert.equal(f.hostOf('https://music.example.org/'), 'music.example.org');
  assert.equal(f.hostOf('not a url'), null);
  assert.equal(f.hostOf(''), null);
});

test('durations read in plain units', () => {
  assert.equal(f.fmtDuration(400), '0 s');
  assert.equal(f.fmtDuration(59_400), '59 s');
  assert.equal(f.fmtDuration(120_000), '2 min');
  assert.equal(f.fmtDuration(154_000), '2 min 34 s');
  assert.equal(f.fmtDuration(7_260_000), '2 h 1 min');
});

test('problem lines are one mark and one sentence', () => {
  assert.equal(f.problemLine('error', 'It broke. Fix it.'), '✖ It broke. Fix it.');
  assert.equal(f.problemLine('warning', 'It wobbled.'), '⚠ It wobbled.');
  // A newline never splits a problem across lines.
  assert.equal(f.problemLine('error', 'first\nsecond'), '✖ first second');
});

test('stems share missing on the analyzer: cause, path and fix', () => {
  assert.equal(
    f.stemsShareMissingProblem('/var/sub-wave/stems'),
    'Stems not saved: the analyzer cannot see the stems share (/var/sub-wave/stems has no .subwave-stems marker). ' +
      'Mount the share on the analyzer host, then run Start tagging again.',
  );
  assert.equal(f.isStemsShareMissing('stems root has no .subwave-stems marker (share not mounted here?)'), true);
  assert.equal(f.isStemsShareMissing('separation failed (see analyzer log)'), false);
  assert.equal(f.isStemsShareMissing(undefined), false);
});

test('a model the analyzer failed to load names the model, its message shortened, and the fix', () => {
  const text = f.modelProblem({
    product: 'Sounds-like fingerprint', model: 'CLAP', backend: 'sidecar',
    error: 'CUDA out of memory. Tried to allocate 20.00 MiB (GPU 0; 7.79 GiB total capacity; 6.90 GiB already allocated)\nTraceback …',
  });
  assert.match(text, /^Sounds-like fingerprint skipped: CLAP failed to load on the analyzer \(CUDA out of memory\. /);
  assert.ok(!text.includes('Traceback'), text);
  assert.match(text, /Restart the analyzer once the GPU is free/);
  assert.equal(
    f.modelProblem({ product: 'Beat grid', model: 'Beat This', backend: 'sidecar', error: null }),
    'Beat grid skipped: this analyzer is built without Beat This. Set ANALYZER_HEAVY=1 and recreate the analyzer, or run the -heavy AIO image.',
  );
  // A local worker lives in the controller: the restart named is the controller's.
  assert.match(f.modelProblem({ product: 'Vocals', model: 'Demucs', backend: 'local', error: 'boom' }), /Restart the controller/);
});

test('analyzer and worker failures are translated into a cause and a fix', () => {
  assert.match(f.plainFailure('fetch failed: connect ECONNREFUSED analyzer.local:8080')!.cause, /did not answer/);
  assert.match(f.plainFailure('analyze sidecar 500: analysis worker exited with code -9')!.cause, /worker crashed/);
  assert.match(f.plainFailure('The operation was aborted due to timeout')!.cause, /took too long/);
  assert.match(f.plainFailure('analyze sidecar 503: busy')!.cause, /answered with an error \(HTTP 503\)/);
  assert.match(f.plainFailure('CUDA out of memory')!.cause, /out of GPU memory/);
  assert.equal(f.plainFailure('bpm detection found no beat'), null);
});

test('the systemic-failure guard says what it means in plain words', () => {
  const text = f.systemicFailureProblem(4, 'fetch failed: connect ECONNREFUSED analyzer.local:8080');
  assert.match(text, /^4 tracks in a row failed to analyse: the analyzer did not answer/);
  assert.match(text, /not held against the tracks/);
});

test('the audio scoring result says why nothing was scored, once', () => {
  const noTower = { scored: 0, skipped: 'no text tower' };
  assert.equal(
    f.scoreSummary({ moods: noTower, descriptors: noTower, energy: null }),
    'moods and sound descriptors not scored: the analyzer has no CLAP text model (ANALYZER_HEAVY=1 adds it)',
  );
  assert.equal(
    f.scoreSummary({ moods: { scored: 29, skipped: null }, descriptors: { scored: 29, skipped: null }, energy: 'no spread energies to check' }),
    '29 scored for moods; 29 for sound descriptors; no spread energies to check',
  );
  assert.equal(f.scoreSummary({ moods: { scored: 0, skipped: null }, descriptors: { scored: 0, skipped: null }, energy: null }), 'no new fingerprints to score');
});

test('the run banner lists every step in order with the count, and the machines once', () => {
  assert.deepEqual(
    f.bannerLines({
      title: 'Tagging run',
      steps: ['Read the music library', 'Mood tagging with qwen'],
      machines: ['Navidrome at music.local:4533', 'analyzer at analyzer.local:8080'],
    }),
    [
      '━━ Tagging run · 2 steps',
      '    1. Read the music library',
      '    2. Mood tagging with qwen',
      '    Machines : Navidrome at music.local:4533 · analyzer at analyzer.local:8080',
    ],
  );
});

test('the closing block: total time, step times by name, library, warnings once', () => {
  const lines = f.summaryLines({
    totalMs: 251_000,
    headline: '29 tracks tagged (12 LLM calls)',
    steps: [
      { n: 1, title: 'Read the music library', ms: 64_000, outcome: 'ok' },
      { n: 2, title: 'Separate stems', ms: null, outcome: 'skipped' },
    ],
    library: '74,725 tagged · 17 moods',
    warnings: ['Fallback LLM did not answer.', 'Fallback LLM did not answer.'],
  });
  assert.deepEqual(lines, [
    '■ Finished in 4 min 11 s — 29 tracks tagged (12 LLM calls)',
    '    Step times :',
    '      ✔ [1] Read the music library · 1 min 4 s',
    '      ▷ [2] Separate stems · skipped',
    '    Library    : 74,725 tagged · 17 moods',
    '    Warnings   : 1',
    '      ⚠ Fallback LLM did not answer.',
  ]);
});

test('every line this module writes starts with a run-log mark or indentation', async () => {
  const { carriesOwnMark } = await import('../src/music/tagger-progress.js');
  const samples = [
    ...f.headerLines({ n: 1, total: 1, title: 'x', runsOn: 'y', scope: 'z' }),
    f.skipLine({ n: 1, total: 1, title: 'x', reason: 'y' }),
    f.progressLine(1, 2),
    f.resultLine({ n: 1, total: 1, title: 'x', outcome: 'ok', summary: 'y', ms: 0 }),
    f.problemLine('error', 'x'),
    f.problemLine('warning', 'x'),
    ...f.bannerLines({ title: 'x', steps: ['a'], machines: [] }),
    ...f.summaryLines({ totalMs: 0, headline: '', steps: [], library: '', warnings: [] }),
  ];
  for (const s of samples) assert.ok(carriesOwnMark(s), s);
  assert.equal(carriesOwnMark('Scanned 74,725 tracks'), false);
});
