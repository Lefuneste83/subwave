// `npm run grid-apply`: write every measured beat grid that passes
// music/grid-policy.ts over the head analysis's tempo and bar lines
// (tracks.applyGridToTrack), operator-reverted rows included. A grid answer
// already applies itself as it lands; this is for grids measured before the
// write existed, for a gate that changed since (the refinement: a grid held
// only by its coverage writes its tempo when it is within 10 % of the head's,
// grid-policy.ts), and for undoing a revert.
//
// `npm run grid-apply -- --revert`: the head's own values back on every track
// a grid was written over, and those rows marked reverted, so no later
// analysis re-applies them until `npm run grid-apply` is run again.
//
// `npm run grid-apply -- --reembed-moved`: marks for re-embedding the tracks a
// grid moved the tempo word of whose vectors don't record their words (built
// before the station stored them); the next tagging run rebuilds them.
//
// `--dry-run` counts what any of these would do and writes nothing. Tracks whose
// tempo word moved are marked for re-embedding; the next tagging run (the
// scheduled one, or Library → Tag) rebuilds their vectors.
//
// The sample mode, for checking a gate on a few tracks before the whole
// library:
//   `--ids <file>`: only the tracks listed (one id per line; blank lines and
//     `#` comments skipped), in any mode. An id with no measured grid is
//     reported as `no grid` and left alone.
//   `--report <csv>`: (apply mode) one row per track run: the stored BPM
//     before and after, the head's and the grid's tempo and their ratio, the
//     grid's coverage and steady share, applied before/after, the outcome,
//     which rule passed the tempo (`coverage`, or `refine` under the coverage
//     gate), what stayed held, and the Sound: tempo word before/after. With
//     `--dry-run` it says what WOULD change and the library is not written.
// Paths are plain files: in the production container the state dir is
// /var/sub-wave, so `docker exec subwave-controller npm run grid-apply --
// --dry-run --ids /var/sub-wave/sample.txt --report /var/sub-wave/sample.csv`.

import { readFileSync, writeFileSync } from 'node:fs';
import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import { gridDecision, headRatio, headTempoOf, type GridDecision } from './grid-policy.js';
import { soundWords } from './sound-line.js';
import type { TrackGrid } from './library-db/grid.js';

export interface GridApplyOptions {
  revert: boolean;
  reembedMoved: boolean;
  dryRun: boolean;
  idsFile?: string;
  reportPath?: string;
}

export function parseGridApplyArgs(args: readonly string[]): GridApplyOptions {
  const value = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a file path`);
    return v;
  };
  const opts: GridApplyOptions = {
    revert: args.includes('--revert'),
    reembedMoved: args.includes('--reembed-moved'),
    dryRun: args.includes('--dry-run'),
  };
  const ids = value('--ids');
  const report = value('--report');
  if (ids) opts.idsFile = ids;
  if (report) {
    if (opts.revert || opts.reembedMoved) throw new Error('--report goes with the apply mode only (not --revert or --reembed-moved)');
    opts.reportPath = report;
  }
  return opts;
}

// One track id per line; blank lines and `#` comments skipped; first
// occurrence kept.
export function readIdsFile(path: string): string[] {
  const seen = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const id = line.trim();
    if (id && !id.startsWith('#')) seen.add(id);
  }
  return [...seen];
}

export const REPORT_COLUMNS = [
  'id', 'artist', 'title', 'bpm_before', 'bpm_after', 'head_bpm', 'grid_bpm', 'grid_vs_head', 'coverage', 'steady_share',
  'applied_before', 'applied_after', 'outcome', 'tempo_rule', 'held', 'tempo_word_before', 'tempo_word_after',
] as const;
type ReportRow = Record<(typeof REPORT_COLUMNS)[number], string | number | null>;

function csv(rows: readonly ReportRow[]): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [REPORT_COLUMNS.join(','), ...rows.map((r) => REPORT_COLUMNS.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const r2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const tempoWord = (bpm: number | null) => soundWords({ bpm }).measured.find((w) => w.endsWith(' tempo')) ?? '';

// The outcome label: the same names dry and written, `would ` before a dry one.
function outcomeOf(decision: GridDecision, wasApplied: boolean, dryRun: boolean, written?: db.GridApplyOutcome): string {
  if (written && written !== 'applied') return written;
  const label = decision.bpm
    ? (decision.bars ? 'apply bpm + bars' : 'apply bpm')
    : (wasApplied ? 'restore' : 'hold');
  if (dryRun) return `would ${label}`;
  return label === 'apply bpm + bars' ? 'applied bpm + bars' : 'applied bpm';
}

type TrackFacts = NonNullable<ReturnType<typeof db.gridApplyTrackFacts>>;
const trackFacts = db.gridApplyTrackFacts;

function applyOne(id: string, dryRun: boolean, wantRow: boolean): { outcome: string; refined: boolean; row: ReportRow | null } {
  const g: TrackGrid | null = db.getGrid(id);
  const before = trackFacts(id);
  if (!g || g.status !== 'ok') {
    const outcome = 'no grid';
    return { outcome, refined: false, row: wantRow ? emptyRow(id, before, outcome) : null };
  }
  const head = headTempoOf(g, before?.bpm ?? null);
  const decision = gridDecision(g, head);
  const wasApplied = g.applied === 1;
  let outcome: string;
  let after: { bpm: number | null; applied: number };
  if (dryRun) {
    outcome = outcomeOf(decision, wasApplied, true);
    after = decision.bpm
      ? { bpm: g.bpm, applied: 1 }
      : { bpm: wasApplied ? g.headBpm : before?.bpm ?? null, applied: 0 };
  } else {
    const written = db.applyGridToTrack(id, { force: true });
    outcome = outcomeOf(decision, wasApplied, false, written);
    after = { bpm: trackFacts(id)?.bpm ?? null, applied: db.getGrid(id)?.applied ?? 0 };
  }
  const row: ReportRow | null = wantRow ? {
    id,
    artist: before?.artist ?? '',
    title: before?.title ?? '',
    bpm_before: before?.bpm ?? null,
    bpm_after: after.bpm,
    head_bpm: head,
    grid_bpm: g.bpm,
    grid_vs_head: g.bpm != null ? r2(headRatio(g.bpm, head)) : null,
    coverage: g.coverage,
    steady_share: r2(decision.steadyShare),
    applied_before: g.applied,
    applied_after: after.applied,
    outcome,
    tempo_rule: decision.bpm ? (decision.refined ? 'refine' : 'coverage') : '',
    held: decision.held.join('; '),
    tempo_word_before: tempoWord(before?.bpm ?? null),
    tempo_word_after: tempoWord(after.bpm),
  } : null;
  return { outcome, refined: decision.bpm && decision.refined, row };
}

function emptyRow(id: string, t: TrackFacts | null, outcome: string): ReportRow {
  const row = Object.fromEntries(REPORT_COLUMNS.map((c) => [c, null])) as ReportRow;
  return {
    ...row, id, artist: t?.artist ?? '', title: t?.title ?? '', bpm_before: t?.bpm ?? null, bpm_after: t?.bpm ?? null,
    outcome, tempo_word_before: tempoWord(t?.bpm ?? null), tempo_word_after: tempoWord(t?.bpm ?? null),
  };
}

// The run itself, on an open library. Returns the counts and the summary
// line (also printed by the CLI).
export function runGridApply(opts: GridApplyOptions): { counts: Record<string, number>; summary: string; marked: number | null } {
  const only = opts.idsFile ? readIdsFile(opts.idsFile) : null;
  const inScope = (ids: string[]) => (only ? ids.filter((id) => only.includes(id)) : ids);
  const dirtyBefore = db.textVectorDirtyIds().length;
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  let refined = 0;
  const rows: ReportRow[] = [];
  if (opts.reembedMoved) {
    for (const id of inScope(db.gridIdsApplied(1))) {
      if (db.markGridMovedVectorIfUnknown(id, opts.dryRun)) bump(opts.dryRun ? 'would mark' : 'marked');
    }
  } else if (opts.revert) {
    for (const id of inScope(db.gridIdsApplied(1))) {
      if (opts.dryRun) bump('would restore');
      else bump(db.revertGridOnTrack(id) ? 'restored' : 'unchanged');
    }
  } else {
    // A sample runs every listed id (an unmeasured one reported as such);
    // the whole run, every measured grid.
    for (const id of only ?? db.measuredGridIds()) {
      const r = applyOne(id, opts.dryRun, !!opts.reportPath);
      bump(r.outcome);
      if (r.refined) refined += 1;
      if (r.row) rows.push(r.row);
    }
  }
  if (opts.reportPath) writeFileSync(opts.reportPath, csv(rows));
  const mode = opts.reembedMoved ? 'reembed-moved' : opts.revert ? 'revert' : 'apply';
  const tally = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing to do';
  const summary = `[grid-apply] ${mode}${only ? ` (${only.length} listed ids)` : ''}${opts.dryRun ? ' (dry run, nothing written)' : ''}: ${tally}` +
    (mode === 'apply' ? `; tempo passed by the 10 % refinement ${refined}` : '');
  const marked = opts.dryRun ? null : db.textVectorDirtyIds().length - dirtyBefore;
  return { counts, summary, marked };
}

async function main() {
  const opts = parseGridApplyArgs(process.argv.slice(2));
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  try {
    const { summary, marked } = runGridApply(opts);
    console.log(summary);
    if (opts.reportPath) console.log(`[grid-apply] report: ${opts.reportPath}`);
    if (marked != null) {
      console.log(`[grid-apply] text vectors newly marked for re-embedding: ${marked} (the next tagging run rebuilds them)`);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('grid-apply-cli.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
