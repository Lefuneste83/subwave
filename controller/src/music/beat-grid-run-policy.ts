// Whether a regular run (the GUI's Start tagging / Analyze audio, as a facet
// plan: analyze.ts runPlannedRegularPass) also measures the opt-in beat grid
// and structure facets. Pure; pinned by scripts/beat-grid-run-policy.test.ts,
// and end to end by scripts/beat-grid-regular-run.test.ts.
//
// Only Hot Mix reads them on air (the seam's beat grid, the phrase mix's
// structure), so they ride a regular run only while a show has Hot Mix on
// (settings hotMixStretchWanted, the one copy of that rule). Without one,
// nothing is planned and nothing is said: a station without Hot Mix runs
// exactly as before. Each step needs the analyzer's POSITIVE answer, the
// planner's own rule for both facets (acoustics-plan.ts): an analyzer that
// predates them would read a grid-only item as a full analysis, or refuse a
// structure request. The structure runs without grid capability, on the
// grids already stored.

export interface BeatGridRunInput {
  // A show has Hot Mix on.
  hotMix: boolean;
  // analyzer.gridAvailable() / structureAvailable(): null = not said.
  gridCapable: boolean | null;
  structureCapable: boolean | null;
}

export interface BeatGridRunDecision {
  grid: boolean;
  structure: boolean;
  // Why a step Hot Mix wants does not run this pass, for its skip line in the
  // run log (run-log.ts); absent for a step that runs.
  reasons: Partial<Record<'grid' | 'structure', string>>;
}

export function beatGridRunDecision(input: BeatGridRunInput): BeatGridRunDecision {
  if (!input.hotMix) return { grid: false, structure: false, reasons: {} };
  const reasons: BeatGridRunDecision['reasons'] = {};
  for (const f of ['grid', 'structure'] as const) {
    const capable = f === 'grid' ? input.gridCapable : input.structureCapable;
    if (capable === false) {
      reasons[f] = 'this analyzer reports it cannot measure it; rebuild the analyzer' +
        (f === 'grid' ? ' (the beat grid needs the heavy image built with WITH_BEAT_GRID=1)' : '');
    } else if (capable == null) {
      reasons[f] = 'the analyzer has not said whether it can measure it: an image that predates it ' +
        '(rebuild the analyzer), or one whose workers were still starting; asked again next run';
    }
  }
  return { grid: input.gridCapable === true, structure: input.structureCapable === true, reasons };
}

/**
 * The step's track order: the tracks this run just analysed first (in their
 * order), then the rest of `ids`, so a limited run grids its new tracks before
 * the library's backlog. Ids outside `ids` are dropped; each id appears once.
 */
export function newTracksFirst(ids: readonly string[], first: readonly string[]): string[] {
  const known = new Set(ids);
  const lead = [...new Set(first)].filter((id) => known.has(id));
  const taken = new Set(lead);
  return [...lead, ...ids.filter((id) => !taken.has(id))];
}
