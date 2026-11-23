// `npm run grid-apply` sample mode (music/grid-apply-cli.ts). Pinned:
//   - `--ids <file>` limits the run to those tracks (one id per line; blank
//     lines and `#` comments skipped); no other row is touched;
//   - `--report <csv>` writes one row per id with the stored BPM before and
//     after, the grid's figures, applied before/after and the outcome;
//   - with `--dry-run` the report says what WOULD change and the library is
//     byte-identical afterwards;
//   - the wiring end to end through the real entry point (a child process).
// Run: `npm test -- grid-apply-cli`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-grid-apply-cli-'));
process.env.STATE_DIR = stateDir;
const db = await import('../src/music/library-db.js');
const C = await import('../src/music/grid-apply-cli.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

const SEG = { anchorMs: 480, periodUs: 483871, beats: 700, downbeatMs: 480 };
const answer = (over: Record<string, unknown> = {}) => ({
  version: 1, engine: 'beat_this', model: 'final0', bpm: 124, beatsPerBar: 4, segments: [SEG],
  coverage: 0.97, residualMs: 5, downbeatAgreement: 0.84, mainShare: 0.99, decodedMs: 340_000, ...over,
}) as import('../src/music/library-db/grid.js').GridAnswer;
const BEATS = [500, 987, 1474, 1961, 2448];
const BARS = [500, 2448];

// Grids arrive before this branch's rule ran (a grid measured under the old
// gate), so seed the grid row first and the head after, with the head write's
// own re-apply suppressed by writing the columns directly.
function seed(id: string, headBpm: number, over: Record<string, unknown> = {}) {
  db.upsertTrackMeta(id, { title: `T ${id}`, artist: 'Artist, "quoted"', album: 'B', duration: 340 } as never);
  db.upsertTrackAnalysis(id, { bpm: headBpm, musicalKey: '8A', loudnessLufs: -9, beats: BEATS, bars: BARS, source: 'full' } as never);
  db.writeGridResult(id, { grid: answer(over) });
  // Undo whatever the write applied: the row as an older gate left it.
  if (db.getGrid(id)!.applied === 1) db.revertGridOnTrack(id);
  db.requireDb().prepare('UPDATE track_grid SET applied = 0 WHERE track_id = ?').run(id);
}

const snapshot = () => JSON.stringify([
  db.requireDb().prepare('SELECT * FROM tracks ORDER BY id').all(),
  db.requireDb().prepare('SELECT * FROM track_grid ORDER BY track_id').all(),
]);

seed('refine', 123.05, { coverage: 0.786 });   // held by coverage only, within 10 %
seed('octave', 62, { coverage: 0.786 });       // held: another metrical level
seed('full', 123.05);                          // passes on coverage, bars too
seed('other', 123.05, { coverage: 0.786 });    // not in the sample
const idsFile = join(stateDir, 'sample.txt');
writeFileSync(idsFile, '# sample\nrefine\n\n  octave  \nfull\nnope\nrefine\n');

const parseCsv = (text: string) => {
  const lines = text.trim().split(/\r\n/);
  const cells = (l: string) => {
    const out: string[] = [];
    let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = cells(lines[0]);
  return { head, rows: lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v]))) };
};

test('the ids file: one per line, comments and blanks skipped, de-duplicated in order', () => {
  assert.deepEqual(C.readIdsFile(idsFile), ['refine', 'octave', 'full', 'nope']);
  assert.deepEqual(C.parseGridApplyArgs(['--dry-run', '--ids', 'a.txt', '--report', 'r.csv']),
    { revert: false, reembedMoved: false, dryRun: true, idsFile: 'a.txt', reportPath: 'r.csv' });
  assert.throws(() => C.parseGridApplyArgs(['--ids']), /--ids needs a file/);
  assert.throws(() => C.parseGridApplyArgs(['--revert', '--report', 'r.csv']), /--report/);
});

test('--dry-run --ids --report: the report says what would change and nothing is written', () => {
  const before = snapshot();
  const report = join(stateDir, 'dry.csv');
  const res = C.runGridApply({ revert: false, reembedMoved: false, dryRun: true, idsFile, reportPath: report });
  assert.equal(snapshot(), before, 'the library is unchanged');
  const { head, rows } = parseCsv(readFileSync(report, 'utf8'));
  assert.deepEqual(head, [...C.REPORT_COLUMNS]);
  assert.deepEqual(rows.map((r) => r.id), ['refine', 'octave', 'full', 'nope']);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.refine.artist, 'Artist, "quoted"');
  assert.deepEqual([by.refine.bpm_before, by.refine.bpm_after, by.refine.grid_bpm], ['123.05', '124', '124']);
  assert.deepEqual([by.refine.applied_before, by.refine.applied_after], ['0', '1']);
  assert.equal(by.refine.outcome, 'would apply bpm');
  assert.equal(by.refine.tempo_rule, 'refine');
  assert.equal(by.refine.coverage, '0.786');
  assert.equal(by.refine.held, 'bars: coverage 0.79');
  assert.deepEqual([by.refine.tempo_word_before, by.refine.tempo_word_after], ['upbeat tempo', 'upbeat tempo']);
  assert.deepEqual([by.octave.bpm_before, by.octave.bpm_after, by.octave.outcome], ['62', '62', 'would hold']);
  assert.deepEqual([by.octave.tempo_word_before, by.octave.tempo_word_after], ['slow tempo', 'slow tempo']);
  assert.deepEqual([by.full.outcome, by.full.tempo_rule], ['would apply bpm + bars', 'coverage']);
  assert.equal(by.nope.outcome, 'no grid');
  assert.deepEqual(res.counts, { 'would apply bpm': 1, 'would hold': 1, 'would apply bpm + bars': 1, 'no grid': 1 });
  assert.match(res.summary, /dry run, nothing written/);
  assert.match(res.summary, /by the 10 % refinement 1/);
});

test('--ids --report (write): only the sample moves, and the report reads after the write', () => {
  const report = join(stateDir, 'write.csv');
  const res = C.runGridApply({ revert: false, reembedMoved: false, dryRun: false, idsFile, reportPath: report });
  const bpm = (id: string) => (db.requireDb().prepare('SELECT bpm FROM tracks WHERE id = ?').get(id) as { bpm: number }).bpm;
  assert.equal(bpm('refine'), 124);
  assert.equal(bpm('octave'), 62);
  assert.equal(bpm('full'), 124);
  assert.equal(bpm('other'), 123.05, 'not in the sample: untouched');
  assert.equal(db.getGrid('other')!.applied, 0);
  const by = Object.fromEntries(parseCsv(readFileSync(report, 'utf8')).rows.map((r) => [r.id, r]));
  assert.deepEqual([by.refine.bpm_before, by.refine.bpm_after, by.refine.applied_after, by.refine.outcome], ['123.05', '124', '1', 'applied bpm']);
  assert.deepEqual([by.octave.outcome, by.full.outcome], ['held', 'applied bpm + bars']);
  assert.deepEqual(res.counts, { 'applied bpm': 1, held: 1, 'applied bpm + bars': 1, 'no grid': 1 });
});

test('the entry point wires the flags (child process)', () => {
  db.revertGridOnTrack('refine');
  db.requireDb().prepare('UPDATE track_grid SET applied = 0').run();
  const before = snapshot();
  const report = join(stateDir, 'child.csv');
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const out = execFileSync(tsx, ['src/music/grid-apply-cli.ts', '--dry-run', '--ids', idsFile, '--report', report], {
    env: { ...process.env, STATE_DIR: stateDir }, encoding: 'utf8',
  });
  assert.match(out, /\[grid-apply\] apply \(4 listed ids\) \(dry run, nothing written\): /);
  assert.match(out, /would apply bpm 1/);
  assert.match(out, /report: /);
  assert.equal(snapshot(), before);
  assert.equal(parseCsv(readFileSync(report, 'utf8')).rows.length, 4);
});
