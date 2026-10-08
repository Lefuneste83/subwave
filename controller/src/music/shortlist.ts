// Track Shortlist discovery: a deterministic source plan run against the same
// picker-tool registry the Agentic route uses, so every candidate passes the
// identical show, recency and policy guards. Nothing here calls an LLM, chooses
// a track, or writes queue state.

import { buildPickerTools, type PickerScope } from '../llm/tools.js';
import { SHORTLIST_PASSES_BOUNDS } from '../schemas/settings.js';
import * as library from './library.js';
import { mixCompat, type Analysis } from './mix.js';

export type ShortlistSourceCall = {
  source: string;
  args: Record<string, unknown>;
  family: 'context' | 'continuity' | 'diversity';
};

export type ShortlistPlanningContext = {
  scope: PickerScope;
  // The current track remains a discovery seed, never a shortlist candidate.
  currentTrackId: string | null;
  discoveryPasses: number;
  // Resolved from the show snapshot by the eventual controller call site. The
  // scope carries strict locks; these soft values are only source arguments.
  moods?: string[] | null;
  energies?: string[] | null;
  genres?: string[] | null;
  // Mirrors the existing ε-greedy deep-cut nudge. Callers decide the random
  // draw once, outside this deterministic planner.
  explore?: boolean;
  // Where the family and source rotation starts. The live pick passes a fresh
  // draw so a station does not run the same plan every time one anchor (or a
  // cold start with no anchor) comes round; absent, the rotation is keyed on
  // the anchor id, which keeps a given input reproducible for tests and the
  // Discovery Bench.
  rotationSeed?: number;
  // What the next track should meet: a DJ-mode run's tempo/key target, else
  // the expected predecessor's measured analysis. Orders the finished
  // shortlist (orderByTransitionFit); absent, the plan's order stands.
  transitionTarget?: Analysis | null;
};

const ENERGY_VALUES = new Set(['low', 'medium', 'high']);

function firstString(values: string[] | null | undefined): string | null {
  return values?.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function stableOffset(value: string | null): number {
  let hash = 0;
  for (const char of value || '') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function rotated<T>(values: T[], offset: number): T[] {
  if (!values.length) return [];
  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

// Build a bounded mix of musical context, local continuity and catalogue
// diversity. Search and request-only tools need listener intent, so they do not
// belong in this generic plan. All candidates still pass through the shared
// picker registry and its show, recency and policy guards.
export function planShortlistSources(
  context: ShortlistPlanningContext,
  availableSources: ReadonlySet<string>,
): ShortlistSourceCall[] {
  const budget = Math.max(
    SHORTLIST_PASSES_BOUNDS.min,
    Math.min(SHORTLIST_PASSES_BOUNDS.max, Math.floor(context.discoveryPasses) || SHORTLIST_PASSES_BOUNDS.min),
  );
  const offset = Number.isFinite(context.rotationSeed)
    ? Math.abs(Math.floor(context.rotationSeed as number)) >>> 0
    : stableOffset(context.currentTrackId);
  const lanes: Record<ShortlistSourceCall['family'], ShortlistSourceCall[]> = {
    context: [], continuity: [], diversity: [],
  };
  const add = (
    family: ShortlistSourceCall['family'],
    source: string,
    args: Record<string, unknown> = {},
  ) => {
    if (availableSources.has(source)) lanes[family].push({ source, args, family });
  };

  const mood = firstString(context.moods);
  const energy = context.energies?.find((value): value is 'low' | 'medium' | 'high' => ENERGY_VALUES.has(value)) ?? null;
  const genre = firstString(context.genres) ?? firstString(context.scope.genreLock);
  const ownsDirection = !!(context.scope.episodeSource || context.scope.playlistLock || context.scope.audioWaypoint?.length);

  if (context.scope.episodeSource) add('context', 'episodeArtistTracks');
  if (context.scope.audioWaypoint?.length) add('context', 'tracksTowardJourney');
  if (context.scope.playlistTracks?.length) add('context', 'showPlaylistTracks');
  if (mood) add('context', 'tracksByMood', { mood, energy });
  else if (energy) add('context', 'tracksByEnergy', { energy });
  if (genre) add('context', 'songsByGenre', { genre });
  // The audience is context too, but a station-wide lean. Where an episode,
  // journey or strict playlist owns the direction, a favourites pass either
  // comes back intersected to nothing or pulls against that direction.
  if (!ownsDirection) add('context', 'listenerFavourites');

  if (context.currentTrackId) {
    add('continuity', 'tracksThatSoundLikeThis', { songId: context.currentTrackId });
    add('continuity', 'tracksLikeThis', { songId: context.currentTrackId });
    add('continuity', 'similarSongs', { songId: context.currentTrackId });
  }

  // Strict playlists and sonic journeys own the direction, so they do not
  // spend a pass on an unfocused diversity source.
  const diversity = (context.scope.playlistLock || context.scope.audioWaypoint?.length
    ? []
    : rotated(
      ['deepCuts', 'starredSongs', 'recentlyAdded', 'randomSongs'],
      offset,
    )
  ).filter((source) => availableSources.has(source));
  if (context.explore && diversity.includes('deepCuts')) {
    diversity.splice(diversity.indexOf('deepCuts'), 1);
    diversity.unshift('deepCuts');
  }
  for (const source of diversity) add('diversity', source);

  const calls: ShortlistSourceCall[] = [];
  const families: ShortlistSourceCall['family'][] = ['context', 'continuity', 'diversity'];
  const familyOrder = ownsDirection ? families : rotated(families.filter(family => lanes[family].length), offset);
  if (!ownsDirection) {
    lanes.context = rotated(lanes.context, Math.floor(offset / families.length));
    lanes.continuity = rotated(lanes.continuity, Math.floor(offset / families.length));
    if (context.explore && familyOrder.includes('diversity')) {
      familyOrder.splice(familyOrder.indexOf('diversity'), 1);
      familyOrder.unshift('diversity');
    }
  }
  const cycle = () => ({
    context: [...lanes.context],
    continuity: [...lanes.continuity],
    diversity: [...lanes.diversity],
  });
  let remaining = cycle();
  while (calls.length < budget && familyOrder.some((family) => remaining[family].length)) {
    let added = false;
    for (const family of familyOrder) {
      const call = remaining[family].shift();
      if (call) {
        calls.push(call);
        added = true;
      }
      if (calls.length === budget) break;
    }
    if (!added) break;
    if (!familyOrder.some((family) => remaining[family].length) && calls.length < budget) {
      remaining = cycle();
    }
  }
  return calls;
}

export type ShortlistSourceRun = ShortlistSourceCall & {
  status: 'ok' | 'unavailable' | 'invalid' | 'error';
  returned: number;
  accepted: number;
  elapsedMs: number;
  error?: string;
};

// The picker registry's own slim projection of a track: the same object a
// tool returned to the Agentic model and a corrective re-pick reads from `seen`.
export type PickerCandidate = Record<string, any> & { id: string };
// A Shortlist candidate is that projection plus the source that surfaced it.
export type ShortlistCandidate = PickerCandidate & { shortlistSources: string[] };

export type ShortlistResult = {
  candidates: ShortlistCandidate[];
  sourceRuns: ShortlistSourceRun[];
  uniqueCandidates: number;
  elapsedMs: number;
};

type PickerTool = {
  inputSchema?: { safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ message?: string }> } } };
  execute?: (args: unknown, context: unknown) => Promise<unknown>;
};

type PickerToolSet = Record<string, PickerTool | undefined>;

function trackCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return 0;
  const value = result as { tracks?: unknown; candidates?: unknown };
  if (Array.isArray(value.tracks)) return value.tracks.length;
  if (Array.isArray(value.candidates)) return value.candidates.length;
  return 0;
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : undefined;
}

// Execute an explicit source plan against a freshly-built picker registry.
// `seen` is the existing registry's authoritative, already-filtered and
// de-duplicated candidate accumulator; the size delta is therefore the exact
// number this source contributed to a vanilla agent run. It is also why a
// candidate carries exactly ONE source: a later source that returns an
// already-seen track has it filtered out before this code can see it, so
// provenance is "the source that first surfaced it", never a full list.
export async function executeShortlistPlan(
  tools: PickerToolSet,
  seen: Map<string, any>,
  plan: ShortlistSourceCall[],
): Promise<ShortlistResult> {
  const started = performance.now();
  const sourceRuns: ShortlistSourceRun[] = [];
  const sourcesById = new Map<string, string[]>();

  for (const call of plan) {
    const tool = tools[call.source];
    if (!tool?.execute) {
      sourceRuns.push({ ...call, status: 'unavailable', returned: 0, accepted: 0, elapsedMs: 0 });
      continue;
    }

    const parsed = tool.inputSchema?.safeParse?.(call.args);
    if (parsed && !parsed.success) {
      sourceRuns.push({
        ...call,
        status: 'invalid',
        returned: 0,
        accepted: 0,
        elapsedMs: 0,
        error: parsed.error?.issues?.[0]?.message || 'invalid source input',
      });
      continue;
    }

    const before = new Set(seen.keys());
    const callStarted = performance.now();
    try {
      const result = await tool.execute(parsed?.data ?? call.args, {
        toolCallId: `shortlist:${call.source}`,
        messages: [],
      });
      const added = [...seen.keys()].filter((id) => !before.has(id));
      for (const id of added) sourcesById.set(id, [call.source]);
      sourceRuns.push({
        ...call,
        status: resultError(result) ? 'error' : 'ok',
        returned: trackCount(result),
        accepted: added.length,
        elapsedMs: Math.round(performance.now() - callStarted),
        ...(resultError(result) ? { error: resultError(result) } : {}),
      });
    } catch (err) {
      sourceRuns.push({
        ...call,
        status: 'error',
        returned: 0,
        accepted: 0,
        elapsedMs: Math.round(performance.now() - callStarted),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const candidates = [...seen.entries()].map(([id, candidate]) => ({
    ...candidate,
    shortlistSources: sourcesById.get(id) || [],
  }));
  return {
    candidates,
    sourceRuns,
    uniqueCandidates: candidates.length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// Native entry point: build the same source-owned registry the agent used,
// plan only from sources it actually exposed, then reuse the shared filtered
// accumulator for execution. No LLM calls, choice, or queue writes occur here.
export async function buildShortlist(context: ShortlistPlanningContext): Promise<ShortlistResult> {
  const { tools, seen } = buildPickerTools(context.scope);
  const plan = planShortlistSources(context, new Set(Object.keys(tools)));
  const result = await executeShortlistPlan(tools as PickerToolSet, seen, plan);
  if (!context.transitionTarget) return result;
  return {
    ...result,
    candidates: orderByTransitionFit(result.candidates, context.transitionTarget, (candidate) => library.bpmKeyFor(candidate)),
  };
}

// Soft order, never a filter: the candidates that meet the target cleanly lead
// the list the model reads — the pool's softRankByCompat does the same job
// before its cap. Scored with mix.mixCompat, the station's one tempo + key fit
// (the target's ending key against the candidate's opening key). Stable, so
// ties keep the plan's order, and an unanalysed target changes nothing.
export function orderByTransitionFit<T>(
  candidates: T[],
  target: Analysis | null | undefined,
  analysisOf: (candidate: T) => Analysis,
): T[] {
  if (!target || (target.bpm == null && target.key == null && target.keyEnd == null)) return candidates;
  return candidates
    .map((candidate, index) => ({ candidate, index, fit: mixCompat(target, analysisOf(candidate)) }))
    .sort((a, b) => b.fit - a.fit || a.index - b.index)
    .map(({ candidate }) => candidate);
}
