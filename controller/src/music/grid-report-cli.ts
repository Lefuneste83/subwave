// `npm run grid-report -- [--out DIR]`: the beat grid's dry-run report over
// every track with a measured grid (music/grid-report.ts). Read-only: one read
// of tracks + track_grid, nothing written to the library. Prints the summary;
// with --out, also writes grid-report.csv (one row per track) and
// grid-report-summary.txt there.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import { GRID_WRITE_GATE, compareGrid, gridReportCsv, summariseGridReport, type GridReportRow } from './grid-report.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function formatSummary(rows: readonly GridReportRow[]): string[] {
  const s = summariseGridReport(rows);
  const pct = (n: number) => (s.tracks ? `${Math.round((n / s.tracks) * 100)} %` : '-');
  const out = [
    `tracks with a measured grid: ${s.tracks}`,
    `stored BPM against the grid: same ${s.byRelation.same} (${pct(s.byRelation.same)}), double ${s.byRelation.double}, half ${s.byRelation.half}, ` +
      `3:2 ${s.byRelation['three-halves']}, 2:3 ${s.byRelation['two-thirds']}, other ${s.byRelation.other}, no stored BPM ${s.byRelation['no-stored-bpm']}`,
    `  same tempo: median |Δ| ${s.medianAbsDelta ?? '-'} BPM (librosa's tempo grid, corrected)`,
    `gate (coverage ≥ ${GRID_WRITE_GATE.minCoverage}, main tempo on ≥ ${GRID_WRITE_GATE.minSteadyShare} of the track, at most ${GRID_WRITE_GATE.maxBpm} BPM; bars also downbeat agreement ≥ ${GRID_WRITE_GATE.minDownbeatAgreement}):`,
    `  BPM would be written for ${s.wouldWriteBpm} (${pct(s.wouldWriteBpm)}); ${s.bpmChangesOver1} of them move by more than 1 BPM`,
    `  held (stored value kept): ${s.held}`,
    `  Sound: tempo word moves (text vector re-embedded): ${s.reEmbeds} (${pct(s.reEmbeds)})`,
    `  bars would be written for ${s.wouldWriteBars}; today's first bar line off the grid's downbeat on ${s.barShifts}`,
  ];
  const big = rows.filter((r) => r.wouldWriteBpm && r.relation !== 'same').slice(0, 25);
  if (big.length) {
    out.push('', 'tempo corrections the gate would write (first 25):');
    for (const r of big) {
      out.push(`  ${String(r.storedBpm ?? '-').padStart(7)} → ${String(r.gridBpm).padStart(7)}  ${r.relation.padEnd(12)} ${r.reEmbed ? 're-embed ' : '         '}${r.artist} — ${r.title}`);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = flag(args, '--out');
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  const rows: GridReportRow[] = [];
  for (const { id, grid } of db.allMeasuredGrids()) {
    const t = db.getTrack(id);
    if (!t) continue;
    const row = compareGrid({ ...t, id }, grid);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  const summary = formatSummary(rows);
  for (const line of summary) console.log(line);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'grid-report.csv'), gridReportCsv(rows));
    writeFileSync(join(outDir, 'grid-report-summary.txt'), summary.join('\n') + '\n');
    console.log(`\nwritten: ${join(outDir, 'grid-report.csv')}, grid-report-summary.txt`);
  }
  db.close();
}

if (process.argv[1]?.endsWith('grid-report-cli.ts')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
