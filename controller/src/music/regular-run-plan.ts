// What a regular run (the tagger, Analyze audio: no --facets) measures, decided
// from the facet table like the CLI planner, so a GUI run converges to the same
// end state as `npm run analyze -- --facets … --where needs` (B24). Pure; the
// caller loads the state and hands planRegularRun a loader for the stem
// priority and budget, called only when there is stems-only work. Pinned by
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

import { planAcoustics, type AcousticsPlan, type FacetPlanCount, type PlanCapabilities, type SkipReason, type TrackFacets } from './acoustics-plan.js';
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

export type StemsInput = NonNullable<RegularRunInput['stems']>;

const stemsOnly = (i: { facets: Facet[] }) => i.facets.length === 1 && i.facets[0] === 'stems';

function basePlan(input: Omit<RegularRunInput, 'stems' | 'limit'>): AcousticsPlan {
  return planAcoustics({
    ids: input.ids,
    facets: regularRunFacets(input.wants),
    where: { kind: 'needs' },
    state: input.state,
    capabilities: input.capabilities,
    placeTail: true,
  });
}

/**
 * The regular run's plan, loading the stem priority and budget only when the
 * run has stems-only work. That decision reads the UNBUDGETED plan: one that
 * ran without the stem input has already dropped every stems-only item, so
 * deciding from it never loaded the budget, and a failed separation or an
 * evicted stem set was never planned again from the GUI (B29).
 */
export async function planRegularRun(
  input: Omit<RegularRunInput, 'stems'>,
  loadStems: () => Promise<StemsInput>,
): Promise<AcousticsPlan> {
  const base = basePlan(input);
  const stems = base.items.some(stemsOnly) ? await loadStems() : undefined;
  return finishPlan(base, { ...input, stems });
}

export function regularRunPlan(input: RegularRunInput): AcousticsPlan {
  return finishPlan(basePlan(input), input);
}

function finishPlan(base: AcousticsPlan, input: RegularRunInput): AcousticsPlan {
  const rest = base.items.filter(i => !stemsOnly(i));
  const wanted = base.items.filter(stemsOnly);
  // Why each stems-only item was left out, when it was: outside the priority
  // scan (excluded there), or past the budget's free slots.
  const stemDrop = new Map<string, SkipReason>();
  let stemItems = wanted;
  if (wanted.length > 0) {
    const s = input.stems;
    const order = new Map((s?.priority ?? []).map((id, i) => [id, i] as const));
    const reserved = rest.filter(i => i.request.stems && !s?.existing.has(i.id)).length;
    const room = Math.max(0, (s?.headroom ?? 0) - reserved);
    const ranked: typeof wanted = [];
    for (const i of wanted) {
      // Without a stem input there is no budget to plan against.
      if (!s) stemDrop.set(i.id, 'stem-budget');
      else if (order.has(i.id)) ranked.push(i);
      else stemDrop.set(i.id, 'stem-scan');
    }
    ranked.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    stemItems = ranked.slice(0, room);
    for (const i of ranked.slice(room)) stemDrop.set(i.id, 'stem-budget');
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
    const why = stemDrop.get(i.id) ?? 'limit';
    for (const f of i.facets) {
      const c = count.get(f)!;
      c.skipped[why] = (c.skipped[why] ?? 0) + 1;
    }
  }
  return { ...base, items, byFacet };
}
