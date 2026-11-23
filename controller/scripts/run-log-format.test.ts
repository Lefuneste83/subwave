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
    f.scoreSummary({ moods: { scored: 29, skipped: null }, descriptors: { scored: 29, skipped: null }, energy: 'no copied energies to check' }),
    '29 scored for moods; 29 for sound descriptors; no copied energies to check',
  );
  assert.equal(f.scoreSummary({ moods: { scored: 0, skipped: null }, descriptors: { scored: 0, skipped: null }, energy: null }), 'no new fingerprints to score');
});

// Step 1's detail lines: plain words, one line each, a label first.
test('replaced files: one plain line, the counts behind it only in debug', () => {
  assert.equal(f.replacedFilesLine({ changeTimes: { complete: true, futureDated: 0 }, replaced: 0 }), 'Replaced files: none since the last run');
  assert.equal(
    f.replacedFilesLine({ changeTimes: { complete: true, futureDated: 0 }, replaced: 9, stems: { removed: 9, failed: 0 } }),
    'Replaced files: 9 (same path, new audio) — their analysis is due again, 9 stem sets dropped',
  );
  assert.equal(
    f.replacedFilesLine({ changeTimes: { complete: true, futureDated: 0 }, replaced: 0, accepted: { count: 3, resent: 1 } }),
    'Replaced files: 3 accepted as they are — their analysis is kept, 1 with a new size gets its stems separated again',
  );
  assert.equal(
    f.replacedFilesLine({ changeTimes: { complete: true, futureDated: 0 }, replaced: 0, held: 1201 }),
    'Replaced files: 1,201 found — on hold until you answer (see the warning)',
  );
  assert.match(f.replacedFilesLine({ changeTimes: null, replaced: 0 }),
    /^Replaced files: none found, checked by file size only — Navidrome's change times could not be read \(.*refused.*kept the password back.*\)$/);
  assert.match(f.replacedFilesLine({ changeTimes: { complete: false, futureDated: 2 }, replaced: 1, stems: { removed: 0, failed: 0 } }),
    /^Replaced files: 1 \(same path, new audio\) — their analysis is due again · the change list was only partly read, so the next run reads it again · 2 files dated in the future skipped \(a wrong clock on the files\)$/);
  assert.equal(f.replacedFilesLine({ walkedNothing: true, changeTimes: null, replaced: 0 }), 'Replaced files: not checked (the walk read nothing)');
  assert.equal(
    f.replacedFilesDebug({ read: 3, since: '2026-11-23T05:40:49.659Z', bySize: 1, byTime: 2 }),
    'replaced-file check: 3 change times read since 2026-11-23T05:40:49.659Z; 1 by size, 2 by change time',
  );
});

test('the walk\'s other changes: one plain line each', () => {
  assert.deepEqual(f.walkChangeLines({ adopted: 0, pruned: 0 }), []);
  assert.deepEqual(f.walkChangeLines({ adopted: 3, pruned: 29 }), [
    'Re-linked: 3 tracks whose Navidrome ID changed — their tags and analysis are kept',
    'Removed: 29 tracks no longer in Navidrome',
  ]);
  assert.equal(
    f.eraSuspectLine(8687),
    'Release years: 8,687 tracks are on compilations or reissues, so their album year is not used — an original-year lookup is queued for them',
  );
  assert.equal(f.walkSummary({ walked: 149, newTracks: 29 }), '149 tracks read, 29 new to tag');
});

test('fetching track details: named, sourced and counted by what is on', () => {
  const all = { lastfm: true, lyrics: true, years: true };
  assert.equal(f.enrichTitle(all), 'Fetch Last.fm tags, lyrics and original release years');
  assert.equal(f.enrichTitle({ lastfm: false, lyrics: true, years: false }), 'Fetch lyrics');
  assert.equal(
    f.enrichScope({ ...all, metaTracks: 29, trackTags: 0, yearTracks: 29, pool: 74725 }),
    '29 tracks for Last.fm tags, 29 for lyrics, 29 for an original release year, out of 74,725 in the library',
  );
  assert.equal(
    f.enrichScope({ lastfm: false, lyrics: true, years: true, metaTracks: 29, trackTags: 0, yearTracks: 0, pool: 149 }),
    '29 tracks for lyrics, out of 149 in the library',
  );
  assert.equal(
    f.enrichSummary({ ...all, tracks: 29, tagsFound: 11, lyricsFound: 0, yearLookups: { asked: 29, found: 4, errors: 2 } }),
    'Last.fm tags for 11 of 29, lyrics for 0 of 29, original release years for 4 of 29 (2 lookups failed, retried later)',
  );
  assert.equal(
    f.enrichSummary({ lastfm: false, lyrics: true, years: false, tracks: 29, tagsFound: 0, lyricsFound: 3, yearLookups: { asked: 0, found: 0, errors: 0 } }),
    'lyrics for 3 of 29',
  );
});

test('results carry no internal concept: relabels, spread energies, re-votes, second looks', () => {
  const summary = f.scoreSummary({
    moods: { scored: 29, relabelled: 149, skipped: null }, descriptors: { scored: 29, relabelled: 149, skipped: null }, energy: null,
  });
  assert.equal(summary, '29 scored for moods; 29 for sound descriptors');
  const energy = f.energyResult({ scope: 19696, corrected: 0, agreed: 12800, undecided: 6896, skipped: null });
  assert.deepEqual(energy, {
    summary: 'energies copied from similar tracks: 0 of 19,696 corrected from the audio, 12,800 confirmed, 6,896 kept (the audio is not clear-cut)',
  });
  assert.deepEqual(f.energyResult({ scope: 0, corrected: 0, agreed: 0, undecided: 0, fillScope: 0, filled: { high: 0, medium: 0, low: 0 }, skipped: null }),
    { summary: 'no copied energies to check; no missing energies to fill' });
  assert.equal(
    f.librarySummary({ tagged: 149, moods: 17, genres: 1, embedded: 149, bySource: { llm: 69, propagated: 4, 'uncertain-llm': 76 } }),
    '149 tracks tagged (145 by the LLM, 4 from similar tracks) · 149 with similarity vectors · 17 moods · 1 genre',
  );
  assert.equal(f.selfCheckScope(), 'a sample of tracks already tagged, tagged again from their similar tracks alone and compared');
  assert.equal(
    f.selfCheckSummary({ sampled: 147, gatePassed: 2, moodJaccard: 0.5, energyMatched: 9, energyComparable: 14 }),
    '147 tracks compared: similar tracks alone could tag 1% of them; for those, moods match 50% and energy 64%',
  );
  assert.equal(f.selfCheckSummary({ sampled: 0, gatePassed: 0, moodJaccard: null, energyMatched: 0, energyComparable: 0 }),
    'nothing to compare against (not enough trusted tags)');
  for (const text of [summary, ...Object.values(energy), f.selfCheckScope()]) {
    assert.doesNotMatch(text, /relabel|spread|re-?vot|second look|neighbour|propagat/i, text);
  }
});

// One progress rule for every step: at most ~10 lines, never closer than 15 s.
test('progress is due every 10% of the total and at least 15 s apart, whichever is rarer', () => {
  const due = (done: number, total: number | null, lastDone: number, gapMs: number) =>
    f.progressDue({ done, total, lastDone, sinceLastMs: gapMs });
  assert.equal(due(7_000, 74_725, 0, 60_000), false, 'under 10% of the total');
  assert.equal(due(7_500, 74_725, 0, 14_999), false, 'under 15 s');
  assert.equal(due(7_500, 74_725, 0, 15_000), true);
  assert.equal(due(240, 240, 216, 60_000), false, 'the result line says the last one');
  assert.equal(due(25, 240, 0, 60_000), true);
  assert.equal(due(3, 29, 0, 20_000), true);
  assert.equal(due(50_000, null, 0, 14_000), false, 'no total known: time alone');
  assert.equal(due(50_000, null, 0, 15_000), true);
});

test('an analysis scope says where its tracks come from', () => {
  const needs: Array<[string, number]> = [['intro, tempo and key', 240], ['outro', 240]];
  assert.equal(
    f.scopeProducts({ tracks: 240, pool: 74_725, needs, from: { new: 192, replaced: 48, other: 0 } }),
    '240 tracks: 192 new and 48 replaced files, out of 74,725 in the library — 240 need intro, tempo and key, 240 outro',
  );
  assert.equal(
    f.scopeProducts({ tracks: 260, pool: 74_725, needs: [], from: { new: 192, replaced: 48, other: 20 } }),
    '260 tracks: 192 new, 48 replaced files and 20 already due, out of 74,725 in the library',
  );
  assert.equal(f.scopeProducts({ tracks: 29, pool: 149, needs: [], from: { new: 0, replaced: 0, other: 29 } }),
    '29 of 149 tracks in the library', 'nothing new or replaced: the plain form');
  assert.equal(f.scopeProducts({ tracks: 29, pool: 149, needs: [] }), '29 of 149 tracks in the library');
});

test('the model lane result counts the stem sets saved', () => {
  assert.equal(
    f.analysisSummary({ done: 240, failed: 0, products: [['sounds-like', 240], ['vocals', 240]], stems: { asked: 240, saved: 240, shareMissing: 0 } }),
    '240 done, 0 failed · 240 sounds-like, 240 vocals, 240 stem sets saved',
  );
  assert.equal(
    f.analysisSummary({ done: 240, failed: 0, products: [], stems: { asked: 240, saved: 230, shareMissing: 0 } }),
    '240 done, 0 failed · 230 of 240 stem sets saved (10 got no stems back from the analyzer)',
  );
  assert.equal(
    f.analysisSummary({ done: 149, failed: 0, products: [['vocals', 149]], stems: { asked: 149, saved: 0, shareMissing: 149 } }),
    '149 done, 0 failed · 149 vocals; stems not saved for 149 (they wait for the stems share)',
  );
});

test('a step that ran alongside another reports its own work time and says so', () => {
  assert.equal(
    f.resultLine({ n: 13, total: 14, title: 'Quality self-check', outcome: 'ok', summary: '150 tracks compared', ms: 3_000, alongside: 'the analysis' }),
    '✔ [13/14] Quality self-check — 150 tracks compared · 3 s (ran alongside the analysis)',
  );
  const lines = f.summaryLines({
    totalMs: 60_000, headline: '', library: '', warnings: [],
    steps: [{ n: 13, title: 'Quality self-check', ms: 3_000, outcome: 'ok', alongside: 'the analysis' }],
  });
  assert.equal(lines[2], '      ✔ [13] Quality self-check · 3 s (ran alongside the analysis)');
});

test('the energy figures go on their own line under a short result', () => {
  const s = { scope: 19_645, corrected: 6, agreed: 12_771, undecided: 6_868, fillScope: 72,
    filled: { high: 26, medium: 35, low: 11 }, overruleScope: 55_008, overruled: 5, skipped: null };
  assert.equal(f.energyChanged(s), '83 energies set from the audio');
  assert.equal(f.energyChanged({ scope: 10, corrected: 0, agreed: 10, undecided: 0, skipped: null }), 'no energy changed');
  assert.equal(
    f.energyDetail(s),
    'Energies: copied from similar tracks: 6 of 19,645 corrected from the audio, 12,771 confirmed, 6,868 kept (the audio is not clear-cut); ' +
      '72 of 72 missing energies filled from the audio (26 high, 35 medium, 11 low); 5 of 55,008 LLM energies changed where the audio clearly says otherwise',
  );
  const short = f.scoreSummary({ moods: { scored: 240, skipped: null }, descriptors: { scored: 240, skipped: null }, energy: f.energyChanged(s) });
  assert.equal(short, '240 scored for moods; 240 for sound descriptors; 83 energies set from the audio');
  assert.ok(f.resultLine({ n: 9, total: 14, title: 'Score moods, sound descriptors and energies from the audio (CLAP)', outcome: 'ok', summary: short, ms: 4_000 }).length < 180);
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
