// The Library tagging panel's beat grid and structure rows: the two opt-in
// facets a regular run (Start tagging) measures while a show has Hot Mix on
// (controller music/beat-grid-run-policy.ts), counted by /library/coverage at
// the last library count. Pure, so the wording and the gate are tested alone.

export interface BeatGridCoverage {
  // A show has Hot Mix on. Absent on an older controller.
  gridWanted?: boolean;
  // What the analyzer reports; null = unknown.
  gridAvailable?: boolean | null;
  structureAvailable?: boolean | null;
  // As of the last library count; null = not counted yet.
  gridMeasured?: number | null;
  gridDue?: number | null;
  structureMeasured?: number | null;
  structureDue?: number | null;
}

export interface BeatGridRow {
  key: 'grid' | 'structure';
  label: string;
  // Measured over measured + due (tracks with no steady pulse settle and drop
  // out of both); null when there is nothing to show a share of.
  pct: number | null;
  status: string;
  hint: string;
}

const n = (v: number) => v.toLocaleString('en-GB');

/** The rows to show: none unless a show has Hot Mix on or a grid or structure
 *  is already stored. */
export function beatGridRows(c: BeatGridCoverage | null | undefined, analysisOff: boolean): BeatGridRow[] {
  if (!c) return [];
  const wanted = c.gridWanted === true;
  if (!wanted && !((c.gridMeasured ?? 0) > 0 || (c.structureMeasured ?? 0) > 0)) return [];
  const idle = wanted ? '' : ' No show has Hot Mix on, so new tracks are not measured.';
  const row = (
    key: BeatGridRow['key'],
    measured: number | null | undefined,
    due: number | null | undefined,
    capable: boolean | null | undefined,
  ): BeatGridRow => {
    const counted = measured != null && due != null;
    const pct = !analysisOff && counted && measured + due > 0 ? Math.floor((measured / (measured + due)) * 100) : null;
    const status = analysisOff
      ? 'engine off'
      : capable === false
        ? key === 'grid'
          ? 'engine can’t measure the beat grid — needs the heavy analyzer built with WITH_BEAT_GRID=1'
          : 'engine can’t measure the structure — rebuild the analyzer'
        : counted
          ? `${n(measured)} measured · ${n(due)} due${pct != null ? ` · ${pct}%` : ''}`
          : 'not counted yet — press Re-count';
    return key === 'grid'
      ? {
          key, pct, status,
          label: 'Beat grid · Hot Mix',
          hint: `Used by Hot Mix shows to beat-match each seam; measured by Start tagging while a show has Hot Mix on.${idle}`,
        }
      : {
          key, pct, status,
          label: 'Track structure · Hot Mix',
          hint: `Used by a Hot Mix show’s phrase mix; measured by Start tagging on each track’s beat grid, right after it.${idle}`,
        };
  };
  return [
    row('grid', c.gridMeasured, c.gridDue, c.gridAvailable),
    row('structure', c.structureMeasured, c.structureDue, c.structureAvailable),
  ];
}
