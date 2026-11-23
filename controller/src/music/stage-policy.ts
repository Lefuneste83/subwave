// Which whole-file reads of a run keep the sidecar's copy of the track
// (docker/analyzer/server.py StageCache), so that the track is streamed from
// the music server once per run instead of once per whole-file step. Pure;
// pinned by scripts/stage-policy.test.ts and, end to end, by
// scripts/beat-grid-regular-run.test.ts.
//
// A planned regular run reads a new track's WHOLE file up to three times,
// each a separate stream of the full file: loudness + edges (the lead
// whole-file slice, before the model lane), then, while a show has Hot Mix
// on, the beat grid and the structure measured on it (after the model lane).
// The three decode the same bytes, so the copy changes no figure: it only
// saves the second and third download.
//
// A read keeps the copy only when another whole-file read of the same track
// is expected later in the run: the lead slice when the track's grid is due,
// the grid when the analyzer can measure a structure (whether the new grid's
// bars are trusted is only known once it is written; an untrusted one leaves
// its copy unread until the run releases it). The structure and the rest of
// the whole-file lane only ever reuse a copy: they are a track's last read,
// and a backlog slice that kept copies would fill the budget with files read
// once. A copy that does not fit (the sidecar's ANALYZE_STAGE_MAX_GB) is
// simply not kept, and that track streams as it always did.

export type StageStep = 'lead' | 'grid' | 'structure' | 'rest';

export interface StageKeepInput {
  /** This track's beat grid is due in this run (Hot Mix on, analyzer able). */
  gridDue: boolean;
  /** The analyzer measures the structure (`=== true`). */
  structureCapable: boolean;
}

export function stageKeep(step: StageStep, input: StageKeepInput): boolean {
  if (step === 'lead') return input.gridDue;
  if (step === 'grid') return input.structureCapable;
  return false;
}

// The key a track's copy goes under: the run's token first, so the run can
// release all of its copies by that prefix (analyzer.releaseStage).
export function stageKey(token: string, trackId: string): string {
  return `${token}/${trackId}`;
}
