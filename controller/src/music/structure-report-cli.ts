// `npm run structure-report -- [--ids-file FILE] [--ids a,b] [--json]`: the
// structure facet's points per track (music/structure-report.ts): bars, the
// full section's start, the first and last hard kick, intro and outro bars.
// Read-only: nothing is written to the library. Without ids, every track with
// a measured structure; --json prints the rows as JSON for comparing with the
// offline prototype.

import { readFileSync } from 'node:fs';
import * as db from './library-db.js';
import * as embeddings from './embeddings.js';
import { formatStructureReport, structureReport } from './structure-report.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function idsOf(args: string[]): string[] | undefined {
  const list = flag(args, '--ids');
  const file = flag(args, '--ids-file');
  if (!list && !file) return undefined;
  const raw = [
    ...(list ? list.split(',') : []),
    ...(file ? readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '')) : []),
  ];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

async function main() {
  const args = process.argv.slice(2);
  const ids = idsOf(args);
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  try {
    const rows = structureReport(ids);
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 1));
    else for (const line of formatStructureReport(rows)) console.log(line);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('structure-report-cli.ts')) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
