// `npm run grid-apply`: write every measured beat grid that passes
// music/grid-policy.ts over the head analysis's tempo and bar lines
// (tracks.applyGridToTrack), operator-reverted rows included. A grid answer
// already applies itself as it lands; this is for grids measured before the
// write existed, and for undoing a revert.
//
// `npm run grid-apply -- --revert`: the head's own values back on every track
// a grid was written over, and those rows marked reverted, so no later
// analysis re-applies them until `npm run grid-apply` is run again.
//
// `--dry-run` counts what either would do and writes nothing. Tracks whose
// tempo word moved are marked for re-embedding; the next tagging run (the
// scheduled one, or Library → Tag) rebuilds their vectors.

import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import { gridDecision } from './grid-policy.js';

async function main() {
  const args = process.argv.slice(2);
  const revert = args.includes('--revert');
  const dryRun = args.includes('--dry-run');
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  const dirtyBefore = db.textVectorDirtyIds().length;
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  if (revert) {
    const ids = db.gridIdsApplied(1);
    for (const id of ids) {
      if (dryRun) bump('would restore');
      else bump(db.revertGridOnTrack(id) ? 'restored' : 'unchanged');
    }
  } else {
    for (const id of db.measuredGridIds()) {
      if (dryRun) {
        const g = db.getGrid(id);
        const d = gridDecision(g);
        bump(d.bpm ? (d.bars ? 'would apply bpm + bars' : 'would apply bpm') : 'would hold');
        continue;
      }
      bump(db.applyGridToTrack(id, { force: true }));
    }
  }
  const marked = db.textVectorDirtyIds().length - dirtyBefore;
  console.log(`[grid-apply] ${revert ? 'revert' : 'apply'}${dryRun ? ' (dry run, nothing written)' : ''}:`,
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing to do');
  if (!dryRun) {
    console.log(`[grid-apply] text vectors newly marked for re-embedding: ${marked} (the next tagging run rebuilds them)`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
