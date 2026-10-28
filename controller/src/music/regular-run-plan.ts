// What a regular run (the tagger, Analyze audio: no --facets) measures, decided
// from the facet table like the CLI planner, so a GUI run converges to the same
// end state as `npm run analyze -- --facets … --where needs` (B24). Pure; the
// caller loads the state, the stem priority and budget. Pinned by
// scripts/regular-run-plan.test.ts, and end to end in tail-placement.test.ts.
//
// Two lanes, in this order (analyze.ts runPlannedRegularPass):
//  1. the whole-file ffmpeg lane (loudness v2 + edges, `wholeFileBackfillPlan`)
//     for the tracks lane 2 is about to read with head or tail due
//     (`leadIds`): their tail is then placed from fresh edges on its one read;
//  2. the model lane, this plan: head, tail, and the opt-in CLAP / vocal /
//     stems, where needs. Loudness and edges never ride it: in the facet
//     protocol `loudness` IS the whole-file measurement, so it belongs to lane 1
//     (wide, no Python models), never to the model pool.
// Then the rest of lane 1 (the library outside lane 2), as before.
//
// Differences from the legacy widenings it replaces (needsAnalysisIds,
// unanalysedAudioIds, needsVocalIds, needsStemsIds):
//  - an outdated tail (an older version, an end-of-file window, a capped
//    download) is planned again, as the CLI's `needs` does, but only once the
//    edges can place it (`placeTail`); without edges a re-read would give the
//    same window, due again, on every run;
//  - stems keep the legacy order and budget: stems-only work goes last, in
//    music/stem-priority.ts order, capped at the cache's headroom less what the
//    other items will write, because the budget always binds on a real library
//    and this slice IS which tracks get stems.
// Only used where the whole-file lane is on and the analyzer speaks the facet
// protocol (both fork-side). Every other station keeps the legacy pass,
// byte-identical.

import { planAcoustics, type AcousticsPlan, type FacetPlanCount, type PlanCapabilities, type TrackFacets } from './acoustics-plan.js';
import type { Facet } from './library-db/facets.js';

export interface RegularRunWants {
  clap: boolean;
  vocal: boolean;
  stems: boolean;
}

/** The model lane's facets for this run, dependency order (head before tail). */
export function regularRunFacets(w: RegularRunWants): Facet[] {
  return [
    'head', 'tail',
    ...(w.clap ? (['clap'] as const) : []),
    ...(w.vocal ? (['vocal'] as const) : []),
    ...(w.stems ? (['stems'] as const) : []),
  ];
}

/**
 * The tracks the model lane will read with head or tail due: lane 1 measures
 * their edges first. Not limited by placeTail (a stored tail lacking edges is
 * exactly what lane 1 is for).
 */
export function leadIds(ids: readonly string[], state: ReadonlyMap<string, TrackFacets>): string[] {
  return planAcoustics({
    ids, facets: ['head', 'tail'], where: { kind: 'needs' }, state,
    capabilities: { clap: null, demucs: null, tailVocal: null },
  }).items.map(i => i.id);
}

export interface RegularRunInput {
  ids: readonly string[];
  state: ReadonlyMap<string, TrackFacets>;
  wants: RegularRunWants;
  capabilities: PlanCapabilities;
  limit?: number;
  // Stems only, read when the plan has stems-only work: the priority order
  // (db.needsStemsIds with the like signals), the budget's free track slots,
  // and the tracks whose stem dir already exists (a rewrite costs no slot).
  stems?: { priority: readonly string[]; headroom: number; existing: ReadonlySet<string> };
}

export function regularRunPlan(input: RegularRunInput): AcousticsPlan {
  const base = planAcoustics({
    ids: input.ids,
    facets: regularRunFacets(input.wants),
    where: { kind: 'needs' },
    state: input.state,
    capabilities: input.capabilities,
    placeTail: true,
  });
  const stemsOnly = (i: { facets: Facet[] }) => i.facets.length === 1 && i.facets[0] === 'stems';
  const rest = base.items.filter(i => !stemsOnly(i));
  const wanted = base.items.filter(stemsOnly);
  let stemItems = wanted;
  if (wanted.length > 0) {
    const s = input.stems;
    const order = new Map((s?.priority ?? []).map((id, i) => [id, i] as const));
    const reserved = rest.filter(i => i.request.stems && !s?.existing.has(i.id)).length;
    const room = Math.max(0, (s?.headroom ?? 0) - reserved);
    stemItems = wanted
      .filter(i => order.has(i.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .slice(0, room);
  }
  const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : Infinity;
  const items = [...rest, ...stemItems].slice(0, limit);

  // Recount what was actually planned, and say why the rest was left.
  const kept = new Set(items.map(i => i.id));
  const byFacet: FacetPlanCount[] = base.byFacet.map(c => ({ ...c, skipped: { ...c.skipped }, planned: 0 }));
  const count = new Map(byFacet.map(c => [c.facet, c] as const));
  for (const i of items) for (const f of i.facets) count.get(f)!.planned += 1;
  for (const i of base.items) {
    if (kept.has(i.id)) continue;
    for (const f of i.facets) {
      const c = count.get(f)!;
      c.skipped.limit = (c.skipped.limit ?? 0) + 1;
    }
  }
  return { ...base, items, byFacet };
}
