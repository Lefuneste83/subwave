// Acoustic-analysis pass — fills bpm / musical_key / intro_ms for tracks that
// lack them, resumably. Shared by the `npm run tag` phase and `npm run analyze`.
// The DSP lives in music/analyzer.ts; with no backend this is a clean no-op.

import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import * as stemCacheStore from './stem-cache.js';
import * as subsonic from './subsonic.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { deriveVocalFromLyrics, clipRangesToTail, type LyricVocalResult } from './lyric-vocal.js';
import { stemStampDecision } from './stem-stamp-policy.js';
import { runAudioMoodPass } from './audio-moods.js';
import { runAudioDescriptorPass } from './audio-descriptor-pass.js';
import { audioEnergyOptions, runAudioEnergyPass } from './propagated-energy.js';
import { reportProgress } from './tagger-progress.js';
import * as runlog from './run-log.js';
import * as F from './run-log-format.js';
import { LOCAL_WHERE, analysisBackendWhere, analyzerWhere } from './run-log-where.js';
import { quietAfterMinutes, quietGateDecision, quietOnlyEnabled, type QuietState } from './analyze-quiet-pure.js';
import { dispatchAnalysis, type DispatchOutcome } from './analyze-dispatch.js';
import {
  analysisModeForTrack,
  backfillDecision,
  failureCountsAgainstTrack,
  SYSTEMIC_FAILURE_RUN,
  tailVocalBackfillAvailable,
} from './analyze-capability.js';
import { probeListenerCount } from '../broadcast/listeners.js';
import { sweepKeepLastFromDisk } from '../broadcast/pick-stems.js';
import { planAcoustics, planStateFacets, type AcousticsPlan, type WorkRequest } from './acoustics-plan.js';
import { hotMixStretchWanted } from '../settings/liquidsoap.js';
import { beatGridRunDecision, newTracksFirst } from './beat-grid-run-policy.js';
import { stageKeep, stageKey, type StageStep } from './stage-policy.js';

// An opt-in facet (the beat grid, the structure) failed and nothing else was
// asked of the track: a failure for the pass's systemic guard like any other,
// stamped on that facet's own row alone (each carries its reason, and the
// structure the grid it was asked on).
type OptInFailures = { grid?: string; structure?: { reason: string; gridAt: string } };
class OptInFailure extends Error {
  constructor(readonly failed: OptInFailures) {
    super([
      ...(failed.grid != null ? [failed.grid] : []),
      ...(failed.structure ? [failed.structure.reason] : []),
    ].join('; '));
  }
}
import { leadIds, planRegularRun, regularRunFacets, type RegularRunWants } from './regular-run-plan.js';

// The run log's analysis steps (run-log.ts). A tag run and a CLI analyze run
// plan them in their banners (analysisStepDefs); each pass below opens its
// own step, and a step a pass never reaches is listed as skipped.
export const ANALYSIS_STEP = {
  lead: 'analysis.lead',
  models: 'analysis.models',
  score: 'analysis.score',
  grid: 'analysis.grid',
  structure: 'analysis.structure',
  backlog: 'analysis.backlog',
} as const;
type AnalysisStepId = typeof ANALYSIS_STEP[keyof typeof ANALYSIS_STEP];

// What a regular run will ask for, by the operator's switches (no probe): the
// model lane's products name its step.
function laneWants(opts: { audioBackfill?: boolean; vocalBackfill?: boolean }): { clap: boolean; vocal: boolean; stems: boolean } {
  let stems = false;
  try { stems = settings.get()?.audio?.stemCache === true; } catch { /* unreadable: off */ }
  return { clap: opts.audioBackfill ?? audioBackfillDefault(), vocal: opts.vocalBackfill ?? vocalBackfillDefault(), stems };
}

// The analysis steps a regular run plans, in the order it runs them.
export function analysisStepDefs(opts: { audioBackfill?: boolean; vocalBackfill?: boolean } = {}): runlog.StepDef[] {
  const wants = laneWants(opts);
  const wholeFile = config.analyzer.wholeFile;
  return [
    ...(wholeFile ? [{ id: ANALYSIS_STEP.lead, title: F.STEP_TITLE.lead }] : []),
    { id: ANALYSIS_STEP.models, title: F.modelLaneTitle(wants) },
    ...(wants.clap ? [{ id: ANALYSIS_STEP.score, title: F.STEP_TITLE.score }] : []),
    ...(beatGridWanted()
      ? [{ id: ANALYSIS_STEP.grid, title: F.STEP_TITLE.grid }, { id: ANALYSIS_STEP.structure, title: F.STEP_TITLE.structure }]
      : []),
    ...(wholeFile ? [{ id: ANALYSIS_STEP.backlog, title: F.STEP_TITLE.backlog }] : []),
  ];
}

const STEP_DEFAULT_TITLE: Record<AnalysisStepId, string> = {
  [ANALYSIS_STEP.lead]: F.STEP_TITLE.lead,
  [ANALYSIS_STEP.models]: 'Analyse the audio',
  [ANALYSIS_STEP.score]: F.STEP_TITLE.score,
  [ANALYSIS_STEP.grid]: F.STEP_TITLE.grid,
  [ANALYSIS_STEP.structure]: F.STEP_TITLE.structure,
  [ANALYSIS_STEP.backlog]: F.STEP_TITLE.backlog,
};

function analysisStep(id: AnalysisStepId): runlog.Step {
  return runlog.step(id, STEP_DEFAULT_TITLE[id]);
}

// Said once per process: the analyzer did not answer.
let unreachableSaid = false;
function skipUnreachable(step: runlog.Step): void {
  if (!unreachableSaid) {
    unreachableSaid = true;
    runlog.problem('warning', F.analyzerUnreachableProblem(F.hostOf(analyzer.answeringBase() || config.analyzer.urls[0])));
  }
  step.skip('the analyzer did not answer');
}

// Said once per process: tracks left out after repeated failures.
let excludedSaid = false;

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
  // Re-scan: --re-analyze redoes ONLY the already-analysed population (captured
  // before the clear), never the remainder. Off for the standalone entry point.
  rescan?: boolean;
  // Widen to tracks with bpm/key but no CLAP vector; defaults from
  // ANALYZE_AUDIO_EMBEDDING.
  audioBackfill?: boolean;
  // Widen to tracks with vocal_ranges_json NULL. Demucs is expensive and opt-in;
  // defaults from ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  vocalBackfill?: boolean;
  // A facet plan (music/acoustics-plan.ts) REPLACES the scope: exactly its
  // tracks, each with its own worker flags. reAnalyze and the four widenings
  // are ignored. Absent = today's pass, unchanged.
  plan?: AcousticsPlan;
  // False: skip the closing zero-shot scoring (audio moods, descriptors, the
  // library-wide audio-energy check). For a step that writes no CLAP vector
  // (the beat grid, the structure), where it would only repeat the model
  // lane's own pass over the same vectors.
  scoreAudio?: boolean;
  // A planned regular run's whole-file steps: the run's copy of each track on
  // the sidecar (stage-policy.ts), so a track is streamed once per run. Set
  // by runPlannedRegularPass only.
  stage?: StageRun;
  // The run-log step this pass reports as (run-log.ts); default the model lane.
  step?: AnalysisStepId;
  // Problems found before the pass (a model that failed to load, a stems
  // share offline), said under its step's header.
  notices?: Array<[F.ProblemKind, string]>;
}

interface StageRun {
  token: string;
  step: StageStep;
  // The lead tracks whose grid this run will measure.
  gridDue: ReadonlySet<string>;
  structureCapable: boolean;
}

// Env wins ON, never off; else the admin toggle (settings.audio.embeddings).
function audioBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_AUDIO_EMBEDDING || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.embeddings === true;
  } catch {
    return false;
  }
}

// Same precedence as audio: env wins on, else settings.audio.vocalActivity.
function vocalBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_VOCAL_ACTIVITY || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.vocalActivity === true;
  } catch {
    return false;
  }
}

// Read by /library/coverage to decide whether to show the vocal row (#646).
export function vocalActivityWanted(): boolean {
  return vocalBackfillDefault();
}

// The audio twin of vocalActivityWanted(), so the panel doesn't re-derive it.
export function audioEmbeddingWanted(): boolean {
  return audioBackfillDefault();
}

// A show has Hot Mix on, so a regular run measures the beat grid and the
// structure (beat-grid-run-policy.ts). Read by /library/coverage too, so the
// panel shows those rows on the same rule. Unreadable settings read as off.
export function beatGridWanted(): boolean {
  try {
    return hotMixStretchWanted(settings.get());
  } catch {
    return false;
  }
}

// Quiet-times gate (#1099) — same env-wins-on precedence as the toggles above,
// but re-read from DISK on every check so a mid-scan flip takes effect in both
// directions (#1102). Any parse failure falls back to the cached settings.
interface QuietConfig {
  enabled: boolean;
  minutes: number;
}

async function readQuietConfig(): Promise<QuietConfig> {
  let audio: any = null;
  try {
    audio = JSON.parse(await readFile(`${config.stateDir}/settings.json`, 'utf8'))?.audio;
  } catch {
    try {
      audio = settings.get()?.audio;
    } catch {
      audio = null;
    }
  }
  const enabled = quietOnlyEnabled(process.env.ANALYZE_QUIET_ONLY, audio);
  return { enabled, minutes: quietAfterMinutes(audio) };
}

// How often the paused pass re-checks Icecast (one status fetch, no history).
const QUIET_POLL_MS = 30_000;

interface QuietGate {
  state: QuietState;
  paused: boolean; // for one-per-transition logging, not decision logic
}

// Block until the gate allows the next track. Sits BETWEEN tracks, so only the
// next compute waits. Unbounded by design (Stop button / admin toggle).
async function waitForQuiet(gate: QuietGate, progress: { done: number; total: number }): Promise<void> {
  for (;;) {
    const quiet = await readQuietConfig();
    // Skip the probe while off; the pure helper still resets the quiet clock.
    const count = quiet.enabled ? await probeListenerCount() : null;
    const d = quietGateDecision(gate.state, {
      enabled: quiet.enabled,
      count,
      now: Date.now(),
      quietAfterMs: quiet.minutes * 60_000,
    });
    gate.state = d.state;
    if (d.proceed) {
      if (gate.paused) {
        gate.paused = false;
        runlog.note('The stream is quiet again: analysis resumes.');
        // The per-track reporter only fires every 25 tracks, so restore now.
        reportProgress({ phase: 'analyze', label: 'Analysing audio', done: progress.done, total: progress.total });
      }
      return;
    }
    // An unknown count never reaches here: the gate fails open.
    const why = count && count > 0 ? `${count} listening` : 'waiting out the quiet window';
    if (!gate.paused) {
      gate.paused = true;
      runlog.note(`Analysis paused (${why}): it resumes after ${quiet.minutes} min with no listeners.`);
    }
    reportProgress({
      phase: 'analyze',
      label: `Waiting for quiet (${why})`,
      done: progress.done,
      total: progress.total,
    });
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

export interface AnalyzeStats {
  available: boolean;
  backend: string;
  analyzed: number;
  failed: number;
  scope: number;
  // 0 when the backend has no CLAP model loaded.
  audioEmbedded: number;
  // Includes instrumentals (stored as []). 0 when off or demucs is absent.
  vocalAnalyzed: number;
  // The opt-in whole-file backfill that followed the pass (absent when it
  // did not run).
  wholeFile?: { analyzed: number; failed: number; scope: number };
  // The beat grid and structure steps of a planned regular run while a show
  // has Hot Mix on, both steps summed (absent when neither measured a track).
  beatGrid?: { analyzed: number; failed: number; scope: number };
}

// Provenance label stamped into audio_embedding_meta; the worker owns the model.
const AUDIO_MODEL_LABEL = process.env.CLAP_MODEL || 'laion-clap';

// The scoring step: zero-shot audio moods and sound descriptors over the
// stored sounds-like vectors, then the library-wide energy check over the
// cosines. Best-effort: a mood or descriptor failure must never fail the pass;
// the next one retries.
async function scoreAudioMoods(): Promise<void> {
  const vectors = db.audioVectorCount();
  // A run that did not plan the step (sounds-like off) and has no vectors says
  // nothing, unless the energy check below finds work.
  const planned = runlog.runLog.planned(ANALYSIS_STEP.score);
  let st: runlog.Step | null = planned || vectors > 0 ? analysisStep(ANALYSIS_STEP.score) : null;
  const step = (): runlog.Step => (st ??= analysisStep(ANALYSIS_STEP.score));
  if (st && vectors > 0) {
    st.start({
      runsOn: `${analyzerWhere(analyzer.answeringBase())} (CLAP text model) · energies on this controller`,
      scope: F.scoreScope({ vectors, moods: db.idsNeedingAudioMoods().length, descriptors: db.idsNeedingAudioDescriptors().length }),
    });
  }
  const failed = (what: string, err: any): F.ScoreStats => {
    step().start();
    runlog.problem('warning', `${what} failed (the next run retries): ${F.shortenAnalyzerMessage(String(err?.message || err))}`);
    return { scored: 0, skipped: 'failed' };
  };
  let moods: F.ScoreStats;
  let descriptors: F.ScoreStats;
  try {
    moods = await runAudioMoodPass();
  } catch (err: any) {
    moods = failed('Scoring audio moods', err);
  }
  try {
    descriptors = await runAudioDescriptorPass();
  } catch (err: any) {
    descriptors = failed('Scoring sound descriptors', err);
  }
  // Must run AFTER the mood pass, which writes the cosines it calibrates
  // against. Separately wrapped so a failure here doesn't cost the mood labels.
  // The result says how many energies changed; the figures follow on their
  // own line under it.
  let energy: string | null = null;
  let energyDetail: string | null = null;
  try {
    const stats = runAudioEnergyPass(audioEnergyOptions(settings.get()));
    energyDetail = F.energyDetail(stats);
    energy = energyDetail ? F.energyChanged(stats) : null;
  } catch (err: any) {
    failed('The energy check', err);
  }
  if (!st?.started && energy == null) {
    st?.skip('no sounds-like fingerprints to score yet');
    return;
  }
  for (const [what, s] of [['mood', moods], ['descriptor', descriptors]] as const) {
    if (s.relabelled) runlog.debug(`${what} labels re-derived from stored scores: ${s.relabelled}`);
  }
  // No fingerprint to score: the step is the energy check alone.
  if (!step().started) step().start({ runsOn: `${LOCAL_WHERE} (energies only: no sounds-like fingerprints to score)` });
  step().done({ summary: F.scoreSummary({ moods, descriptors, energy }) });
  if (energyDetail) step().note(energyDetail);
}

async function lyricVocalFor(id: string, wanted: boolean): Promise<LyricVocalResult | null> {
  if (!wanted) return null;
  try {
    return deriveVocalFromLyrics(await subsonic.getStructuredLyrics(id));
  } catch {
    return null;
  }
}

function lyricTailRanges(id: string, outro: Pick<analyzer.OutroInfo, 'startMs'>, lyricVocal: LyricVocalResult) {
  const durMs = (Number(db.getTrack(id)?.durationSec) || 0) * 1000;
  const windowStartMs = durMs > 0 ? Math.min(outro.startMs, durMs - 20_000) : outro.startMs;
  return clipRangesToTail(lyricVocal.vocalRanges, windowStartMs, durMs > 0 ? durMs : null);
}

// The opt-in whole-file backfill (ANALYZE_WHOLE_FILE): a facet plan for
// loudness v2 + edges over every track that needs either (or over `ids`),
// exactly what `--facets loudness,edges` would plan. null when the switch is
// off; an analyzer known to lack the facets gets nothing planned (skipped,
// counted).
export async function wholeFileBackfillPlan(limit?: number, ids?: readonly string[]): Promise<AcousticsPlan | null> {
  if (!config.analyzer.wholeFile) return null;
  const facets = [...db.WHOLE_FILE_FACETS];
  const available = await analyzer.isAvailable().catch(() => false);
  // An unknown answer can be a probe that reached the sidecar while its pool
  // was still starting (remembered until restart): ask once more first.
  if (available && analyzer.wholeFileAvailable() == null) await analyzer.refreshCapabilities().catch(() => {});
  // An automatic widening needs POSITIVE support, like the tail-vocal one: an
  // analyzer that predates the facets never says so, and sending them anyway
  // fails every request. An explicit `--facets` run still plans on unknown.
  const capable = available && analyzer.wholeFileAvailable() === true;
  return planAcoustics({
    ids: ids ? [...ids] : db.allTrackIdsOrdered(),
    facets,
    where: { kind: 'needs' },
    state: db.loadFacetState(facets),
    capabilities: { clap: null, demucs: null, tailVocal: null, wholeFile: capable, loudnessCurve: analyzer.loudnessCurveAvailable() },
    limit,
  });
}

// A tail measurement is stored (outro or trailing silence), whichever window
// it came from.
function hasMeasuredTail(t: { outro?: unknown; tailSilenceMs?: number | null } | null): boolean {
  return !!t && (t.outro != null || t.tailSilenceMs != null);
}

// Why the opt-in backfill planned nothing for tracks that need it. Only an
// analyzer that SAYS it cannot run the facets is known to lack them; one that
// has not said is either an image that predates them or one whose workers had
// not started when it was asked, and is asked again next run.
export function wholeFileSkipNotice(capability: boolean | null): string {
  return capability === false
    ? 'the analyzer reports it cannot measure it (no ffmpeg in its image); rebuild the analyzer'
    : 'the analyzer has not said whether it can measure it: an image that predates it ' +
      '(rebuild the analyzer), or one whose workers were still starting; asked again next run';
}

// Stems need the analyzer to read the station's own state folder (the stem
// cache lives in it): one whose state mount is down or not the station's
// answers a staged path with 422 path_unavailable, and the track is analysed
// by URL without its stems, or not at all when stems were all it was asked.
// Nothing is stamped, so the planner asks again next run; said once per pass
// with the count, never per track. Before this a mount that failed at the
// analyzer host's boot cost every new track its stems for hours, unsaid.
export function sharedStateNotice(tracks: number, stateRoot: string): string {
  return F.sharedStateProblem(tracks, stateRoot);
}

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (opts.plan) return runAnalysisPassOnce(opts);
  // One scope engine (B24): where the whole-file lane is on and the analyzer
  // speaks the facet protocol, a regular run plans from the facet table like
  // the CLI (regular-run-plan.ts), so a GUI run converges to the same state;
  // while a show has Hot Mix on it also measures the beat grid and the
  // structure (runBeatGridSteps). A forced redo (--re-analyze) and every other
  // station keep the legacy pass, which never measures those two.
  if (!opts.reAnalyze && (await plannedRegularRunAvailable())) return runPlannedRegularPass(opts);
  // The whole-file facets ride a regular run only when the operator opted in,
  // as facet plans (same quiet gate, same failure rules). The regular pass
  // places each track's tail window from its stored edges
  // (analyzer.tailWindowFor), so the tracks it is about to analyse get theirs
  // FIRST: measured after it, a new track's edges arrive too late, its tail is
  // read off the end of the file, stored one version below, and nothing in the
  // run goes back to it. Only those tracks go first: the rest of the backfill
  // (library-wide when the lane is first switched on, or after a loudness
  // version bump) still runs after the regular pass, so it never holds a new
  // track's bpm/key back for hours. A failing slice costs its own figures,
  // never the regular pass.
  const lead = await runWholeFileBackfill({
    limit: opts.limit, ids: db.needsAnalysisIds(opts.limit), step: ANALYSIS_STEP.lead, noticeSkip: false,
  });
  const stats = await runAnalysisPassOnce(opts);
  // The rest of the library (ids: every track that needs the facets); the one
  // slice that says when the analyzer cannot measure them.
  const rest = stats.available
    ? await runWholeFileBackfill({ limit: opts.limit, ids: undefined, step: ANALYSIS_STEP.backlog, noticeSkip: true })
    : null;
  runlog.runLog.skipOpen([ANALYSIS_STEP.grid, ANALYSIS_STEP.structure],
    stats.available ? 'needs whole-file analysis on and an analyzer that measures each product on request' : 'the analyzer did not answer');
  if (!stats.available) runlog.runLog.skipOpen([ANALYSIS_STEP.backlog, ANALYSIS_STEP.score], 'the analyzer did not answer');
  if (!lead && !rest) return stats;
  const wholeFile = {
    analyzed: (lead?.analyzed ?? 0) + (rest?.analyzed ?? 0),
    failed: (lead?.failed ?? 0) + (rest?.failed ?? 0),
    scope: (lead?.scope ?? 0) + (rest?.scope ?? 0),
  };
  return { ...stats, wholeFile };
}

async function plannedRegularRunAvailable(): Promise<boolean> {
  if (!config.analyzer.wholeFile) return false;
  if (!(await analyzer.isAvailable().catch(() => false))) return false;
  return (await analyzer.facetsAvailable().catch(() => null)) === true && analyzer.wholeFileAvailable() === true;
}

// The regular run as a facet plan (regular-run-plan.ts has the order and why):
// the whole-file lane first for the tracks about to be read with head or tail
// due, then the model lane's plan, then (while a show has Hot Mix on) the beat
// grid and the structure measured on it, then the rest of the whole-file lane.
// The widening decisions are the legacy pass's own; their problems (a model
// that failed to load, a lean image, a stems share offline) are said under
// the model lane's header.
async function runPlannedRegularPass(opts: AnalyzeOptions): Promise<AnalyzeStats> {
  const backend = analyzer.backendLabel();
  const audio = backfillDecision({
    dimension: 'audio', wanted: opts.audioBackfill ?? audioBackfillDefault(),
    capable: analyzer.audioEmbeddingAvailable(), error: analyzer.audioEmbeddingError(), backend,
  });
  const vocal = backfillDecision({
    dimension: 'vocal', wanted: opts.vocalBackfill ?? vocalBackfillDefault(),
    capable: analyzer.vocalActivityAvailable(), error: analyzer.vocalActivityError(), backend,
  });
  const stem = backfillDecision({
    dimension: 'stem', wanted: settings.get()?.audio?.stemCache === true,
    capable: analyzer.vocalActivityAvailable(), error: analyzer.vocalActivityError(), backend,
  });
  const notices: Array<[F.ProblemKind, string]> = [];
  if (!audio.widen && audio.notice) notices.push([analyzer.audioEmbeddingError() ? 'error' : 'warning', audio.notice]);
  if (!vocal.widen && vocal.notice) notices.push([analyzer.vocalActivityError() ? 'error' : 'warning', vocal.notice]);
  if (!stem.widen && stem.notice) notices.push([analyzer.vocalActivityError() ? 'error' : 'warning', stem.notice]);
  let stems = stem.widen;
  if (stems) {
    // An unmounted stems share must not read as an empty cache (stem-cache.ts).
    const root = await stemCacheStore.stemsRootStatus({ readOnly: true });
    if (!root.online) {
      stems = false;
      notices.push(['warning', root.message ?? 'The stems cache is offline: stems are skipped this run']);
    }
  }
  const wants = { clap: audio.widen, vocal: vocal.widen, stems };

  const ids = db.allTrackIdsOrdered();
  const leading = leadIds(ids, db.loadFacetState(['head', 'tail']));
  // The run's copies on the sidecar (stage-policy.ts): a lead track whose
  // grid is due keeps its loudness + edges read for the grid and structure
  // after the model lane. Released after the structure step, and again here
  // whatever happens (a release is idempotent).
  const stage = stageRunFor(leading);
  try {
    return await plannedRegularSteps(opts, ids, leading, stage, wants, notices);
  } finally {
    if (stage) await analyzer.releaseStage(stage.token);
  }
}

// The run's copies, when there is a later whole-file read to serve: the
// analyzer keeps copies and the run measures grids (Hot Mix on, analyzer
// able). `gridDue` is the lead tracks' grid plan, read before the lead slice,
// so the loudness + edges read of a track whose grid is due keeps its copy.
// null otherwise: every whole-file read streams, as before.
function stageRunFor(leading: readonly string[]): StageRun | null {
  if (analyzer.stageAvailable() !== true || !beatGridWanted() || analyzer.gridAvailable() !== true) return null;
  const due = leading.length === 0 ? [] : planAcoustics({
    ids: leading,
    facets: ['grid'],
    where: { kind: 'needs' },
    state: db.loadFacetState(planStateFacets(['grid'])),
    capabilities: { clap: null, demucs: null, tailVocal: null, grid: true },
  }).items.map(i => i.id);
  return { token: randomUUID(), step: 'lead', gridDue: new Set(due), structureCapable: analyzer.structureAvailable() === true };
}

async function plannedRegularSteps(
  opts: AnalyzeOptions,
  ids: readonly string[],
  leading: readonly string[],
  stage: StageRun | null,
  wants: RegularRunWants,
  notices: Array<[F.ProblemKind, string]>,
): Promise<AnalyzeStats> {
  const lead = await runWholeFileBackfill({
    limit: opts.limit, ids: leading, step: ANALYSIS_STEP.lead, noticeSkip: false,
    stage: stage ?? undefined,
  });

  // Read after lane 1: the tails it just made placeable are planned now.
  const state = db.loadFacetState([...regularRunFacets(wants), 'edges']);
  const capabilities = {
    clap: analyzer.audioEmbeddingAvailable(),
    demucs: analyzer.vocalActivityAvailable(),
    tailVocal: analyzer.tailVocalAvailable(),
    wholeFile: true,
  };
  // Stems-only work is ordered and budgeted (stem-priority.ts); sizing the
  // budget walks the cache, so the planner loads it only when there is such work.
  const plan = await planRegularRun({ ids, state, wants, capabilities, limit: opts.limit }, async (planned) => ({
    priority: db.needsStemsIds(undefined, stemCacheStore.likeSignals()),
    headroom: await stemCacheStore.headroomTracks(),
    existing: await stemCacheStore.cachedTrackIdsAmong(planned),
  }));
  logRegularPlan(plan);
  analysisStep(ANALYSIS_STEP.models).retitle(F.modelLaneTitle(wants));
  const stats = await runAnalysisPassOnce({ ...opts, plan, step: ANALYSIS_STEP.models, notices });
  // Before the rest of lane 1: the tracks just analysed already have their
  // whole-file figures (the lead slice), and what is left there is the
  // library's backlog (hours when the lane is first switched on), which must
  // not hold back the grid a Hot Mix show plays new tracks on.
  const beatGrid = stats.available ? await runBeatGridSteps(opts.limit, ids, plan.items.map(i => i.id), stage) : null;
  // The grid and structure were the copies' last readers: free them before
  // the backlog, which only streams.
  if (stage) await analyzer.releaseStage(stage.token);
  const rest = stats.available
    ? await runWholeFileBackfill({ limit: opts.limit, ids: undefined, step: ANALYSIS_STEP.backlog, noticeSkip: true })
    : null;
  if (!stats.available) {
    runlog.runLog.skipOpen([ANALYSIS_STEP.score, ANALYSIS_STEP.grid, ANALYSIS_STEP.structure, ANALYSIS_STEP.backlog], 'the analyzer did not answer');
  }
  const wholeFile = lead || rest
    ? {
        analyzed: (lead?.analyzed ?? 0) + (rest?.analyzed ?? 0),
        failed: (lead?.failed ?? 0) + (rest?.failed ?? 0),
        scope: (lead?.scope ?? 0) + (rest?.scope ?? 0),
      }
    : null;
  return { ...stats, ...(wholeFile ? { wholeFile } : {}), ...(beatGrid ? { beatGrid } : {}) };
}

// The plan's per-product counts, for --verbose (the step's scope line says
// what the operator needs).
function logRegularPlan(plan: AcousticsPlan): void {
  for (const c of plan.byFacet) {
    if (c.matched === 0) continue;
    const skipped = Object.entries(c.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
    runlog.debug(`plan: ${c.facet} ${c.planned} planned of ${c.matched} due${skipped ? ` (skipped: ${skipped})` : ''}`);
  }
}

// The opt-in beat grid, then the structure, for every track that needs them
// (`--where needs`, the tracks this run just analysed first), while a show
// has Hot Mix on (beat-grid-run-policy.ts decides, and gives each skipped
// step its reason). The structure is measured on the grid stored when it is
// planned, so its plan is made only once the grid step has written: planned
// together, a new track has no grid yet (`no-grid`) and would wait a whole run
// for its structure. Each step is non-fatal, like a whole-file slice. null
// when neither measured a track, so a run without Hot Mix returns the stats
// it always did.
async function runBeatGridSteps(
  limit: number | undefined,
  ids: readonly string[],
  analysed: readonly string[],
  stage: StageRun | null = null,
): Promise<AnalyzeStats['beatGrid'] | null> {
  if (!beatGridWanted()) return null;
  // An unknown answer can be a probe that reached the sidecar while its pool
  // was still starting: ask once more first, as the whole-file lane does.
  if (analyzer.gridAvailable() == null || analyzer.structureAvailable() == null) {
    await analyzer.refreshCapabilities().catch(() => {});
  }
  const decision = beatGridRunDecision({
    hotMix: true, gridCapable: analyzer.gridAvailable(), structureCapable: analyzer.structureAvailable(),
  });
  const order = newTracksFirst(ids, analysed);
  const total = { analyzed: 0, failed: 0, scope: 0 };
  let ran = false;
  for (const facet of ['grid', 'structure'] as const) {
    const id = facet === 'grid' ? ANALYSIS_STEP.grid : ANALYSIS_STEP.structure;
    const st = analysisStep(id);
    if (!decision[facet]) {
      const loadError = facet === 'grid' ? analyzer.gridError() : null;
      if (loadError) {
        st.skip('Beat This failed to load on the analyzer');
        runlog.problem('error', F.modelProblem({ product: 'Beat grid', model: 'Beat This', error: loadError, backend: analyzer.backendLabel() }));
      } else {
        st.skip(decision.reasons[facet] ?? 'not measured this run');
      }
      continue;
    }
    try {
      const plan = planAcoustics({
        ids: order,
        facets: [facet],
        where: { kind: 'needs' },
        // Read now: the structure step sees the grids the grid step just wrote.
        state: db.loadFacetState(planStateFacets([facet])),
        capabilities: { clap: null, demucs: null, tailVocal: null, grid: facet === 'grid', structure: facet === 'structure' },
        limit,
      });
      logRegularPlan(plan);
      if (plan.items.length === 0) {
        st.skip('nothing missing');
        continue;
      }
      // No vector written: the model lane already scored this run's. The
      // grid may keep the run's copy for the structure; the structure reuses.
      const s = await runAnalysisPassOnce({ plan, scoreAudio: false, step: id, ...(stage ? { stage: { ...stage, step: facet } } : {}) });
      total.analyzed += s.analyzed;
      total.failed += s.failed;
      total.scope += s.scope;
      ran = true;
    } catch (err) {
      runlog.problem('warning', `${st.title} stopped (the next run retries): ${F.failureReason(err instanceof Error ? err.message : String(err))}`);
      st.skip('stopped by an error');
    }
  }
  return ran ? total : null;
}

// One slice of the whole-file backfill. `ids` limits it to those tracks
// (undefined: every track that needs the facets); `step` is the run-log step
// it reports as; `noticeSkip` says the analyzer-cannot-measure reason (the
// slice after the regular pass; the lead slice just skips).
async function runWholeFileBackfill({ limit, ids, step, noticeSkip, stage }: {
  limit: number | undefined;
  ids: readonly string[] | undefined;
  step: AnalysisStepId;
  noticeSkip: boolean;
  stage?: StageRun;
}): Promise<AnalyzeStats['wholeFile'] | null> {
  if (!config.analyzer.wholeFile) return null;
  const st = analysisStep(step);
  if (ids && ids.length === 0) {
    st.skip('no new tracks to analyse');
    return null;
  }
  try {
    if (!(await analyzer.isAvailable().catch(() => false))) {
      skipUnreachable(st);
      return null;
    }
    const plan = await wholeFileBackfillPlan(limit, ids);
    if (!plan) return null;
    const skipped = plan.byFacet.reduce((n, c) => n + (c.skipped['no-whole-file'] ?? 0), 0);
    if (skipped > 0 && plan.items.length === 0) {
      st.skip(noticeSkip ? wholeFileSkipNotice(analyzer.wholeFileAvailable()) : 'the analyzer has not confirmed it can measure it');
      return null;
    }
    if (plan.items.length === 0) {
      st.skip('nothing missing');
      return null;
    }
    // No closing scoring: a whole-file slice writes no CLAP vector and no
    // mood score, so the zero-shot passes and the library-wide energy check
    // would rerun over inputs it left exactly as they were. They run once,
    // after the model lane (the step that writes vectors), as before; the
    // energy check, idempotent over unchanged inputs, ran here before the
    // model lane and again after the rest of the library for nothing.
    const whole = await runAnalysisPassOnce({ plan, scoreAudio: false, step, ...(stage ? { stage } : {}) });
    return { analyzed: whole.analyzed, failed: whole.failed, scope: whole.scope };
  } catch (err) {
    runlog.problem('warning', `${st.title} stopped (the next run retries): ${F.failureReason(err instanceof Error ? err.message : String(err))}`);
    st.skip('stopped by an error');
    return null;
  }
}

async function runAnalysisPassOnce(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  const st = analysisStep(opts.step ?? ANALYSIS_STEP.models);
  if (!(await analyzer.isAvailable())) {
    // Neither an ANALYZE_URL sidecar nor an ANALYZE_PYTHON venv answered.
    skipUnreachable(st);
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  const backend = analyzer.backendLabel();
  // Said under the step's header once it is printed (its scope and lane are
  // settled below): problems, then plain notes.
  const pending: Array<[F.ProblemKind, string]> = [...(opts.notices ?? [])];
  const pendingNotes: string[] = [];

  // Resolved up front so a --re-analyze not redoing vocal preserves existing
  // vocal_ranges rather than wiping what it won't rebuild.
  const vocalWanted = opts.vocalBackfill ?? vocalBackfillDefault();
  const vocalDecision = backfillDecision({
    dimension: 'vocal',
    wanted: vocalWanted,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  const vocalBackfill = vocalDecision.widen;
  // Stem cache: shares Demucs' separation with vocal detection, so the spend is
  // disk, LRU-swept below. Same three-way capability question as audio/vocal.
  const stemDecision = backfillDecision({
    dimension: 'stem',
    wanted: settings.get()?.audio?.stemCache === true,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  let stemCache = stemDecision.widen;
  // No stem write, backfill or sweep without the cache root's marker: an
  // unmounted stems share must not read as an empty cache (stem-cache.ts).
  // Checked before --re-analyze clears the stems stamps, so an offline cache
  // keeps them.
  if (stemCache) {
    const root = await stemCacheStore.stemsRootStatus({ prepare: true });
    if (!root.online) {
      stemCache = false;
      pending.push(['warning', root.message ?? 'The stems cache is offline: stems are skipped this run']);
    } else if (root.message) {
      pending.push(['warning', root.message]);
    } else if (root.action === 'create' || root.action === 'adopt') {
      runlog.debug(`stem cache: ${root.action === 'create' ? 'created' : 'marked existing cache at'} ${stemCacheStore.stemsRoot()} (${stemCacheStore.STEMS_MARKER})`);
    }
  }

  // Snapshot the already-analysed ids BEFORE the clear wipes the bpm marker.
  // A raw --re-analyze leaves the scope null and redoes the whole library.
  let reAnalyzeScope: string[] | null = null;
  const plan = opts.plan;
  if (plan && opts.reAnalyze) runlog.debug('facet plan given: --re-analyze ignored');
  if (opts.reAnalyze && !plan) {
    if (opts.rescan) reAnalyzeScope = db.analysedIds();
    db.clearAnalysis({ keepVocal: !vocalBackfill, clearStems: stemCache });
    pendingNotes.push(
      `Redo requested: the stored analysis was cleared${vocalBackfill ? '' : ' (vocal ranges kept)'}` +
        (reAnalyzeScope ? `, and only the ${F.fmtCount(reAnalyzeScope.length)} tracks analysed before are redone` : ''),
    );
  }

  const cap = opts.limit && opts.limit > 0 ? opts.limit : undefined;
  // A facet plan brings its own scope: skip the legacy scope queries entirely.
  const bpmIds = plan
    ? []
    : reAnalyzeScope
      ? (cap ? reAnalyzeScope.slice(0, cap) : reAnalyzeScope)
      : db.needsAnalysisIds(cap);
  let ids = bpmIds;

  // Audio backfill: also target analysed tracks lacking a CLAP vector, so
  // embeddings fill in without a full --re-analyze. Two gates: never under a
  // fixed re-scan scope, and only when the backend can emit CLAP vectors
  // (`null`, meaning unknown, still widens).
  const audioWanted = opts.audioBackfill ?? audioBackfillDefault();
  const audioDecision = backfillDecision({
    dimension: 'audio',
    wanted: audioWanted,
    capable: analyzer.audioEmbeddingAvailable(),
    error: analyzer.audioEmbeddingError(),
    backend,
  });
  const audioBackfill = audioDecision.widen;
  if (audioBackfill && !reAnalyzeScope && !plan) {
    const seen = new Set(bpmIds);
    const audioIds = db.unanalysedAudioIds(cap).filter(id => !seen.has(id));
    ids = cap ? [...bpmIds, ...audioIds].slice(0, cap) : [...bpmIds, ...audioIds];
  } else if (audioDecision.notice && !reAnalyzeScope && !plan) {
    // An error for a broken model (operator-clearable), a warning when it was never built.
    pending.push([analyzer.audioEmbeddingError() ? 'error' : 'warning', audioDecision.notice]);
  }
  const audioAdded = ids.length - bpmIds.length;

  // Vocal backfill: same idea, same two gates, for tracks missing vocal-activity
  // ranges. Tail widening also re-targets tracks whose outro predates tail vocal
  // detection, only on an explicit `=== true` — old sidecars never report the
  // flag and a stale image must keep the head-only scope.
  const includeTailMissing = tailVocalBackfillAvailable(analyzer.tailVocalAvailable());
  let vocalAdded = 0;
  let stemAdded = 0;
  if (vocalBackfill && !reAnalyzeScope && !plan) {
    const seen = new Set(ids);
    const vocalIds = db.needsVocalIds(cap, includeTailMissing).filter(id => !seen.has(id));
    const before = ids.length;
    ids = cap ? [...ids, ...vocalIds].slice(0, cap) : [...ids, ...vocalIds];
    vocalAdded = ids.length - before;
  } else if (vocalDecision.notice && !reAnalyzeScope && !plan) {
    // Only when widening was actually attempted.
    pending.push([analyzer.vocalActivityError() ? 'error' : 'warning', vocalDecision.notice]);
  }

  // Stem backfill: the fourth widening. `stemCache` already carries the Demucs
  // gate; suppressed under a fixed re-scan scope like the others. Capped at what
  // the budget holds, and the cap is ANNOUNCED. That same headroom figure gates
  // EVERY stem write in the loop below (#1257), decremented per NET-NEW dir.
  let stemSlotsLeft = 0;
  let existingStemDirs: Set<string> = new Set();
  // Sizing the budget walks every file in the stem cache. A facet plan decides
  // stems per track and sizes the budget itself below, only when it asks for
  // stems: walked here, a tail-only plan waited 12 min on a 45k-dir NFS cache
  // before its first request (5 Oct 2026) for figures it never reads.
  if (stemCache && !plan) {
    stemSlotsLeft = await stemCacheStore.headroomTracks();
    existingStemDirs = await stemCacheStore.cachedTrackIdSet();
  }
  // Net-new stem dirs this pass allocated (settled at the end of the pass).
  const newStemIds: string[] = [];
  let rewroteExistingStems = false;
  if (stemCache && !reAnalyzeScope && !plan) {
    // The loop spends stemSlotsLeft in ids order and the earlier widenings'
    // tracks run FIRST, draining slots before this slice is reached. Reserve
    // them up front, or the announcement over-promises.
    const reserved = ids.filter(id => !existingStemDirs.has(id)).length;
    const backfillSlots = Math.max(0, stemSlotsLeft - reserved);
    if (backfillSlots <= 0) {
      pendingNotes.push(
        stemSlotsLeft <= 0
          ? `Stems: the cache is at its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget, so no more tracks get stems ` +
              '(raise it in Settings → Stems to cache more)'
          : `Stems: the ${reserved} tracks already in this pass take the budget's last ~${stemSlotsLeft} slots, ` +
              'so no other track gets stems this run',
      );
    } else {
      const seen = new Set(ids);
      // Priority-ordered (#1622 FR 14): the budget always binds on a real
      // library, so this slice IS which tracks ever get stems. The ranking and
      // the never-starve reasoning live in music/stem-priority.ts; the like
      // signals it reads are resolved here because library-db must not import
      // the likes store.
      const needing = db.needsStemsIds(undefined, stemCacheStore.likeSignals())
        .filter(id => !seen.has(id));
      // Under --limit, only the slots the bpm/CLAP/vocal scopes haven't already
      // spent are available — sizing off the raw cap would log stem tracks a
      // final slice then silently drops, the exact "reads as finished"
      // truncation the announcement exists to avoid.
      const room = cap ? Math.min(Math.max(0, cap - ids.length), backfillSlots) : backfillSlots;
      const stemIds = needing.slice(0, room);
      if (stemIds.length > 0) {
        ids = [...ids, ...stemIds];
        stemAdded = stemIds.length;
        const left = needing.length - stemIds.length;
        if (left > 0) pendingNotes.push(`Stems: ${F.fmtCount(left)} more tracks wait for later runs (the budget holds ~${F.fmtCount(backfillSlots)} more)`);
      }
    }
  } else if (stemDecision.notice && !reAnalyzeScope && !plan) {
    // Same error/warning split as audio and vocal above.
    pending.push([analyzer.vocalActivityError() ? 'error' : 'warning', stemDecision.notice]);
  }

  // Only ids pulled in solely by the CLAP widening may take the fast path;
  // vocal and stem work applies to every id, so those runs stay full.
  const fullAnalysisIds = new Set(bpmIds);
  if (vocalBackfill || stemCache) {
    for (const id of ids) fullAnalysisIds.add(id);
  }

  // A facet plan replaces everything the widenings above decided: the plan's
  // tracks, in the plan's order, each with its own request flags.
  const planned = new Map<string, WorkRequest>();
  const plannedFacets = new Map<string, db.AnalysisFacet[]>();
  let planStemsOffline = false;
  if (plan) {
    for (const item of plan.items) {
      planned.set(item.id, item.request);
      // The year facet is not the analyzer's (analyze-library runs it apart).
      plannedFacets.set(item.id, item.facets.filter(db.isAnalysisFacet));
    }
    ids = plan.items.map(i => i.id);
    runlog.debug(`facet plan: ${plan.facets.join(', ')} where ${plan.where.kind}${plan.where.reason ? ':' + plan.where.reason : ''}, ${ids.length} tracks`);
    const wantsStems = plan.items.some(i => i.request.stems);
    if (wantsStems) {
      // The plan's own root check: the one above only runs with the settings
      // toggle on, and an unmounted share must not read as an empty cache.
      const root = await stemCacheStore.stemsRootStatus({ prepare: true });
      if (!root.online) {
        planStemsOffline = true;
        pending.push(['warning', root.message ?? 'The stems cache is offline: stems are skipped this run']);
      } else {
        if (root.message) pending.push(['warning', root.message]);
        // The only place a plan sizes the budget (the widening above skips plans),
        // whether or not the settings toggle is on: an explicit stems plan needs it.
        // Only the plan's own tracks are ever looked up in the dir set
        // (allocateStems), so only they are checked.
        stemSlotsLeft = await stemCacheStore.headroomTracks();
        existingStemDirs = await stemCacheStore.cachedTrackIdsAmong(plan.items.filter(i => i.request.stems).map(i => i.id));
      }
    }
  }
  // A facet plan on a backend that speaks the facet protocol asks for exactly
  // the planned facets; an older backend gets the flat request (flags above).
  const useFacets = !!plan && (await analyzer.facetsAvailable()) === true;
  // Read after facetsAvailable(): a local worker has sent its ready message by then.
  const rangedOk = useFacets && analyzer.rangedTailAvailable() === true;
  // A tail the stored edges can place reads its own window (staged copy, or
  // just the window from the stream): the ranged end-of-file read is for an
  // unplaced tail only.
  const isRanged = (id: string): boolean => {
    const f = plannedFacets.get(id);
    return rangedOk && !!f && f.length === 1 && f[0] === 'tail' && !analyzer.tailWindowFor(db.getTrack(id));
  };
  if (plan && !useFacets) pendingNotes.push('This analyzer predates per-product requests: each planned track gets a full analysis');
  if (plan && useFacets) runlog.debug(`facet protocol${rangedOk ? ', tail-only tracks read by HTTP Range' : ''}`);
  let rangedTracks = 0;
  let rangedBytes = 0;
  let rangedSize = 0;
  const fallbackReasons = new Map<string, number>();
  // Tracks whose stems the analyzer could not write: no shared state (sharedStateNotice).
  let stemsWithoutSharedState = 0;
  // The analyzer answered a stems request `unavailable` because the cache
  // root it sees has no marker: the stems share is not mounted on the
  // analyzer host. Said once, and no further stems are requested this pass
  // (each would be separated for nothing); the tracks stay due, since an
  // unavailable answer stamps nothing. An analyzer that predates the facet
  // protocol never says so: its flat answers are unchanged.
  let stemsShareMissing = false;
  // Tracks whose stems were due but not saved because the analyzer cannot see
  // the stems share: they stay due, and the step's result says how many.
  let stemsNotSaved = 0;
  // Stem sets due on the tracks this pass ran, and saved (the analyzer wrote
  // them).
  let stemsAsked = 0;
  let stemsSaved = 0;

  // Pass-wide flags the tail of the pass reports on (sweep, Demucs warning).
  const passStems = plan ? !planStemsOffline && plan.items.some(i => i.request.stems) : stemCache;
  const passVocal = plan ? plan.items.some(i => i.request.vocal) : vocalBackfill;

  // Say what the scope leaves out: "all tracks current" is also true of a
  // library whose files can never be analysed.
  // Said once a run: the tracks left out of every scope after repeated failures.
  const excludedFailures = db.analysisFailedCount();
  if (excludedFailures > 0 && !excludedSaid) {
    excludedSaid = true;
    pending.push([
      'warning',
      `${F.fmtCount(excludedFailures)} track${excludedFailures === 1 ? ' is' : 's are'} left out after ` +
        `${db.MAX_ANALYSIS_FAILURES} failed attempts each; Library → analysis failures lists the reasons`,
    ]);
  }
  const sayPending = (notes = true) => {
    for (const [kind, text] of pending) runlog.problem(kind, text);
    if (notes) for (const text of pendingNotes) st.note(text);
  };

  if (ids.length === 0) {
    st.skip('nothing missing');
    sayPending(false);
    // Zero-shot scoring can still have work (older vectors, changed vocabulary).
    if (opts.scoreAudio !== false) await scoreAudioMoods();
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  if (passStems) await stemCacheStore.markPassPending();
  reportProgress({ phase: 'analyze', label: 'Analysing audio', done: 0, total: ids.length });

  let analyzed = 0;
  let failed = 0;
  let orderedDone = 0;
  // Failures since the last success in THIS pass: bad file vs bad pass.
  let consecutiveFailures = 0;
  // Failure stamps held back until the pass proves it may hand them out: a
  // success flushes the buffer, the systemic guard tripping discards it.
  let pendingFailureStamps: Array<{ id: string; reason: string; optIn?: OptInFailures }> = [];
  const flushFailureStamps = () => {
    for (const f of pendingFailureStamps) {
      try {
        if (f.optIn) {
          if (f.optIn.grid != null) db.writeGridResult(f.id, { failed: f.optIn.grid });
          if (f.optIn.structure) db.writeStructureResult(f.id, { failed: f.optIn.structure.reason }, f.optIn.structure.gridAt);
        } else db.recordAnalysisFailure(f.id, f.reason);
      } catch (stampErr: any) {
        // Never let bookkeeping end the pass.
        runlog.debug(`${f.id}: failure stamp failed: ${stampErr?.message || stampErr}`);
      }
    }
    pendingFailureStamps = [];
  };
  // Failures by their plain reason, and tracks nothing could be asked of, for
  // the step's result.
  const failureReasons = new Map<string, number>();
  let skippedTracks = 0;
  let audioEmbedded = 0;
  let vocalAnalyzed = 0;
  // Only the quiet-clock state lives here, so it carries across tracks.
  const quietGate: QuietGate = { state: { quietSince: null }, paused: false };
  {
    const quiet = await readQuietConfig();
    if (quiet.enabled) {
      pendingNotes.push(`Quiet times on: analysis runs only once the stream has had no listeners for ${quiet.minutes} min`);
    }
  }
  // Stamp the provenance row once, on the first vector written this run.
  let audioMetaStamped = false;
  const audioModelLabel = AUDIO_MODEL_LABEL;
  // One announcement when the stem budget gate first closes mid-pass.
  let stemGateAnnounced = false;

  // Concurrent sidecar jobs stage only AFTER admission, so a quiet-time pause
  // never keeps downloading work that has not started.
  type Prefetch = Promise<{ path: string; complete: boolean } | { err: any } | { skip: true }>;
  // A ranged tail read fetches its own few MB from Navidrome, and a track
  // planned for the whole-file facets alone is streamed whole by the analyzer:
  // neither has a capped download to stage (up to ANALYZE_MAX_BYTES read for
  // nothing).
  // The structure decodes the whole file in the same lane (no model).
  const wholeFileOnly = (songId: string) => {
    const f = useFacets ? plannedFacets.get(songId) : undefined;
    return !!f && f.length > 0 && f.every((x) => db.WHOLE_FILE_LANE_FACETS.includes(x));
  };
  // The beat grid streams the whole file too, but holds a model: never the
  // whole-file lane, and never a staged copy either.
  const streamsWholeOnly = (songId: string) => {
    const f = useFacets ? plannedFacets.get(songId) : undefined;
    return !!f && f.length > 0 && f.every((x) => db.WHOLE_FILE_LANE_FACETS.includes(x) || x === 'grid');
  };
  const prefetch = (songId: string): Prefetch =>
    isRanged(songId) || streamsWholeOnly(songId)
      ? Promise.resolve({ skip: true as const })
      : analyzer.downloadCapped(songId).then((r) => r, (err) => ({ err }));

  type TrackWorkResult = { kind: 'skipped' } | {
    kind: 'analyzed';
    audioEmbedded: boolean;
    vocalAnalyzed: boolean;
  };

  const allocateStems = (id: string): string | undefined => {
    const want = planned.get(id);
    // A planned track gets stems only when its plan asks for them.
    if (plan && (!want?.stems || planStemsOffline)) return undefined;
    if (stemsShareMissing) return undefined;
    const trackStemDecision = stemCacheStore.stemWriteDecision({
      cacheOn: plan ? true : stemCache,
      slotsLeft: stemSlotsLeft,
      hasExistingDir: existingStemDirs.has(id),
    });
    if (trackStemDecision.consumesSlot) {
      stemSlotsLeft -= 1;
      newStemIds.push(id);
    }
    if (trackStemDecision.want && existingStemDirs.has(id)) rewroteExistingStems = true;
    if ((plan ? true : stemCache) && !trackStemDecision.want && !stemGateAnnounced) {
      stemGateAnnounced = true;
      runlog.note('Stems: the cache budget was reached during this step, so the remaining new tracks get no stems (raise it in Settings → Stems to cache more).');
    }
    return trackStemDecision.want ? stemCacheStore.dirFor(id) : undefined;
  };

  // One planned track over the facet protocol: ask for exactly its facets,
  // write each answer to its own columns + facet row (writeFacetResults).
  const runFacetTrack = async (
    id: string,
    localPath: string | null,
    localComplete: boolean | undefined,
    admittedStems?: { dir: string | undefined },
  ): Promise<TrackWorkResult> => {
    const facets = plannedFacets.get(id)!;
    const ranged = isRanged(id);
    // The tail window ends where the music stops, when the edges are known
    // (also for the Demucs tail pass behind vocal and stems: TAIL_WINDOW_FACETS).
    const tailWindow = analyzer.usesTailWindow(facets) ? analyzer.tailWindowFor(db.getTrack(id)) : null;
    const stems_dir = facets.includes('stems') && !stemsShareMissing
      ? (admittedStems ? admittedStems.dir : allocateStems(id))
      : undefined;
    // A tail measured on its own also brings the outro's vocal ranges when the
    // station uses vocal activity — otherwise the vocal facet turns head-only
    // and the regular vocal backfill would chase these tracks forever.
    const wantsVocal = facets.includes('vocal');
    const tailVocals = facets.includes('tail') && !wantsVocal && vocalBackfill;
    const lyricVocal = await lyricVocalFor(id, wantsVocal || tailVocals);
    // The structure is measured on the track's trusted-bars grid, read now and
    // sent with the request; a grid that lost its bars since the plan was made
    // is not asked about (its row reads no-bars already).
    const structureGrid = facets.includes('structure') ? db.structureGridOf(db.getGrid(id)) : null;
    const requestedFacets = facets.filter(f =>
      !(f === 'vocal' && lyricVocal) && !(f === 'stems' && !stems_dir) && !(f === 'structure' && !structureGrid));
    // The run's copy of a track read whole (stage-policy.ts): only a request
    // that streams the whole file and nothing else names one.
    const stage = opts.stage && streamsWholeOnly(id)
      ? {
          key: stageKey(opts.stage.token, id),
          keep: stageKeep(opts.stage.step, { gridDue: opts.stage.gridDue.has(id), structureCapable: opts.stage.structureCapable }),
        }
      : null;
    const res = requestedFacets.length ? await analyzer.analyzeFacets(
      id,
      {
        facets: requestedFacets, ranged, tailVocals: tailVocals && !lyricVocal, stems_dir, complete: localComplete,
        tailWindow, structureGrid, stage,
      },
      ranged ? undefined : (localPath ?? undefined),
    ) : null;
    if (res?.stemsWithoutSharedState) stemsWithoutSharedState += 1;
    if (facets.includes('stems')) stemsAsked += 1;
    const stemsAnswer = res?.facets.stems;
    const shareMissingNow = stemsAnswer?.status === 'unavailable' && F.isStemsShareMissing(stemsAnswer.reason);
    if (shareMissingNow && !stemsShareMissing) {
      stemsShareMissing = true;
      runlog.problem('error', F.stemsShareMissingProblem(stemCacheStore.stemsRoot()));
    }
    // Due, and not saved for want of the share: asked and refused, or no
    // longer asked once the pass knew.
    if (facets.includes('stems') && (shareMissingNow || (stemsShareMissing && !stems_dir && !admittedStems?.dir))) stemsNotSaved += 1;
    if (res?.source.kind === 'ranged') {
      rangedTracks += 1;
      rangedBytes += res.source.bytesRead ?? 0;
      rangedSize += res.source.size ?? 0;
    } else if (res?.source.fallback) {
      fallbackReasons.set(res.source.fallback, (fallbackReasons.get(res.source.fallback) ?? 0) + 1);
    }
    const source: db.FacetSource =
      res?.source.kind === 'ranged' ? 'ranged'
        : res?.source.kind === 'capped-download' ? (res.source.complete === false ? 'capped' : 'url')
        // Whole-file facets alone: the analyzer streamed the URL itself.
        : res?.source.kind === 'whole-file' ? 'url'
        : localComplete === true ? 'full' : localComplete === false ? 'capped' : 'unknown';

    const w: db.FacetWrite = { source, tailUnplaced: facets.includes('tail') && !tailWindow };
    const failures: string[] = [];
    // Facets whose answer counts as a failure although the backend said
    // 'unmeasurable' (see below): not "answered".
    const missed = new Set<db.Facet>();
    let wroteClap = false;
    // The grid's answer is written on its own (writeGridResult): its failure
    // is never the track's analysis failure (library-db/grid.ts).
    let gridResult: db.GridResult | null = null;
    // The structure's the same way (writeStructureResult).
    let structureResult: db.StructureResult | null = null;
    for (const f of requestedFacets) {
      const a = res?.facets[f];
      if (!a) continue;
      if (f === 'structure') {
        if (a.status === 'unavailable') continue;
        if (a.status === 'failed') structureResult = { failed: a.reason ?? 'failed' };
        else if (a.status === 'unmeasurable') structureResult = { unmeasurable: a.reason ?? 'not-measured', version: db.STRUCTURE_FACET_VERSION };
        else structureResult = a.structure ? { structure: a.structure } : { failed: 'malformed structure answer' };
        continue;
      }
      if (f === 'grid') {
        if (a.status === 'unavailable') continue;
        if (a.status === 'failed') gridResult = { failed: a.reason ?? 'failed' };
        else if (a.status === 'unmeasurable') gridResult = { unmeasurable: a.reason ?? 'not-measured', version: db.GRID_FACET_VERSION };
        else gridResult = a.grid ? { grid: a.grid } : { failed: 'malformed grid answer' };
        continue;
      }
      if (a.status === 'failed') { failures.push(db.facetFailure(f, a.reason)); continue; }
      if (a.status === 'unavailable') continue;
      // A placed window the backend could not read, over a tail already
      // measured: the stored tail outranks 'unmeasurable', so recording it
      // would change nothing and the track would stay due, counted ok, on
      // every pass. It is a failure of this track instead: named in
      // analyze_error, and bounded by MAX_ANALYSIS_FAILURES.
      if (a.status === 'unmeasurable' && f === 'tail' && tailWindow && hasMeasuredTail(db.getTrack(id))) {
        failures.push(db.facetFailure(f, `placed window ${a.reason ?? 'not measured'}`));
        missed.add(f);
        continue;
      }
      if (a.status === 'unmeasurable') {
        (w.unmeasurable ??= {})[f] = a.reason ?? 'not-measured';
        continue;
      }
      const r = a.result;
      if (f === 'head') {
        w.head = {
          bpm: r.bpm, musicalKey: r.musicalKey, introMs: r.introMs, confidence: r.confidence,
          sections: r.sections, pace: r.paceCurve, beats: r.beats, bars: r.bars, keyRanges: r.keyRanges,
          leadSilenceMs: r.leadSilenceMs,
        };
      } else if (f === 'loudness') {
        // A whole-file answer is one measurement: integrated loudness, true
        // peak, sample peak and LRA are stored together or not at all.
        if (db.isWholeFileLoudnessVersion(r.loudnessVersion) &&
          [r.loudnessLufs, r.peakDb, r.samplePeakDb, r.loudnessRangeLu].some((v) => v == null)) {
          failures.push(db.facetFailure(f, 'incomplete whole-file loudness answer'));
          continue;
        }
        w.loudness = {
          loudnessLufs: r.loudnessLufs, peakDb: r.peakDb,
          samplePeakDb: r.samplePeakDb ?? null, loudnessRangeLu: r.loudnessRangeLu ?? null,
          version: r.loudnessVersion ?? null, curve: r.wholeLoudnessCurve ?? null,
          curveUnavailable: r.loudnessCurveUnavailable ?? null,
        };
      } else if (f === 'edges') {
        if (r.edgeLeadMs == null || r.edgeTailMs == null || r.decodedDurationMs == null) {
          failures.push(db.facetFailure(f, 'incomplete edges answer'));
          continue;
        }
        w.edges = { leadMs: r.edgeLeadMs, tailMs: r.edgeTailMs, durationMs: r.decodedDurationMs };
      } else if (f === 'tail') {
        w.tail = { outro: r.outro, tailSilenceMs: r.tailSilenceMs, tailStartMs: r.tailStartMs,
          version: r.tailPlaced ? db.placedTailVersion(r.outro, r.tailCurveUnavailable) : null };
      } else if (f === 'clap' && r.audioEmbedding?.length === db.AUDIO_EMBEDDING_DIM) {
        w.clap = r.audioEmbedding;
        wroteClap = true;
      } else if (f === 'vocal') {
        // Where the tail vocals were measured: the analyzer says "edges" when it
        // separated the placed window (tail_window), else the file's end.
        w.vocal = { vocalRanges: r.vocalRanges ?? [], tailVocalRanges: a.tailVocalRanges,
          tailWindow: r.tailPlaced ? 'placed' : 'end' };
      } else if (f === 'stems') {
        if (r.stemsCached) stemsSaved += 1;
        const stemStamp = stemStampDecision({
          stemsCached: r.stemsCached,
          tailStems: r.tailStemsLanded ?? null,
          priorTailMisses: db.trackStemTailMisses(id),
          okAnswer: true,
        });
        if (stemStamp.stamp) w.stems = { attempted: true };
        if (stemStamp.tailMisses !== undefined) w.stemsTailMisses = stemStamp.tailMisses;
      }
    }
    if (lyricVocal) {
      if (w.head && lyricVocal.introMs != null) w.head.introMs = lyricVocal.introMs;
      const tail = w.tail && !('unmeasurable' in w.tail) ? w.tail : null;
      const outro = tail?.outro ?? db.getTrack(id)?.outro;
      if (wantsVocal) {
        // Read off the very outro they are merged into.
        w.vocal = { vocalRanges: lyricVocal.vocalRanges,
          tailVocalRanges: outro ? lyricTailRanges(id, outro, lyricVocal) : null, tailWindow: 'stored' };
      } else if (tail?.outro) {
        tail.outro = { ...tail.outro, vocalRanges: lyricTailRanges(id, tail.outro, lyricVocal) };
      }
    }
    const answered = facets.filter((f) => {
      if (f === 'grid' || f === 'structure') return false;
      if (f === 'vocal' && lyricVocal) return true;
      if (missed.has(f)) return false;
      const a = res?.facets[f];
      return a && a.status !== 'failed' && a.status !== 'unavailable';
    });
    const gridAnswered = gridResult != null && !('failed' in gridResult);
    const structureAnswered = structureResult != null && !('failed' in structureResult);
    const writeStructure = (r: db.StructureResult) => db.writeStructureResult(id, r, structureGrid!.gridAt, source);
    // Nothing usable came back: fail the track like a flat analysis would, so
    // the pass's systemic-failure guard sees it. An opt-in facet (grid,
    // structure) that failed alone is an OptInFailure: it counts for that
    // guard, and is stamped on its own row only (flushFailureStamps), never on
    // the track's analysis failures.
    if (failures.length > 0 && answered.length === 0) {
      // An opt-in facet that did answer is kept; the other facets' failure
      // still goes through the guard as the track's own.
      if (gridAnswered) db.writeGridResult(id, gridResult!, source);
      if (structureAnswered) writeStructure(structureResult!);
      throw new Error([
        ...failures,
        ...(gridResult && 'failed' in gridResult ? [db.facetFailure('grid', gridResult.failed)] : []),
        ...(structureResult && 'failed' in structureResult ? [db.facetFailure('structure', structureResult.failed)] : []),
      ].join('; '));
    }
    if (answered.length === 0 && !gridAnswered && !structureAnswered) {
      const optIn: OptInFailures = {
        ...(gridResult && 'failed' in gridResult ? { grid: gridResult.failed } : {}),
        ...(structureResult && 'failed' in structureResult ? { structure: { reason: structureResult.failed, gridAt: structureGrid!.gridAt } } : {}),
      };
      if (optIn.grid != null || optIn.structure) throw new OptInFailure(optIn);
      return { kind: 'skipped' };
    }
    if (gridResult) db.writeGridResult(id, gridResult, source);
    if (structureResult) writeStructure(structureResult);
    if (answered.length === 0) return { kind: 'analyzed', audioEmbedded: false, vocalAnalyzed: false };
    if (failures.length > 0) w.failed = failures.join('; ');
    if (wroteClap && !audioMetaStamped) {
      db.setAudioEmbeddingMeta(audioModelLabel, db.AUDIO_EMBEDDING_DIM);
      audioMetaStamped = true;
    }
    db.writeFacetResults(id, w);
    return { kind: 'analyzed', audioEmbedded: wroteClap, vocalAnalyzed: !!w.vocal };
  };

  const runTrack = async (
    id: string,
    downloadPromise?: Prefetch,
    admittedStems?: { dir: string | undefined },
  ): Promise<TrackWorkResult> => {
    const want = planned.get(id);
    const embeddingOnly = want
      ? want.embeddingOnly
      : analysisModeForTrack(id, fullAnalysisIds, audioBackfill) === 'embedding-only';
    let localPath: string | null = null;
    let localComplete: boolean | undefined;

    try {
      const settled = await (downloadPromise ?? prefetch(id));
      if ('skip' in settled) {
        // ranged / whole-file only: nothing staged
      } else if ('err' in settled) {
        const err: any = settled.err;
        // A non-audio response (stale library entry) is not retryable by url.
        if (err instanceof analyzer.NonAudioResponseError) throw err;
        // Otherwise a transient fetch failure — fall back to the url path.
        runlog.debug(`${id}: prefetch failed (${err?.message || err}); using the url path`);
      } else if ('path' in settled) {
        localPath = settled.path;
        localComplete = settled.complete;
      }
      if (useFacets && plannedFacets.has(id)) {
        return await runFacetTrack(id, localPath, localComplete, admittedStems);
      }
      // embed:true lazy-loads CLAP on the backend; omitted when audio is off so
      // it keeps its env-driven default.
      // A planned track says CLAP on or off explicitly (false = no CLAP for it).
      const embed = want ? want.clap : audioBackfill ? true : undefined;
      const vocalWantedHere = want ? want.vocal : vocalBackfill;
      // Lyric-first vocal ranges (#1125), before spending a Demucs separation.
      const lyricVocal = await lyricVocalFor(id, vocalWantedHere);
      // The concurrent path reserved headroom at admission; serial spends here.
      const stems_dir = admittedStems ? admittedStems.dir : allocateStems(id);
      // A lyric-decided track skips Demucs unless stem caching needs it anyway.
      // Planned: vocal off unless asked — except that a stems request needs the
      // separation, which an explicit vocal=false would veto in the worker.
      const vocal = want
        ? (want.vocal ? (lyricVocal && !stems_dir ? false : true) : (stems_dir ? undefined : false))
        : vocalBackfill ? (lyricVocal && !stems_dir ? false : true) : undefined;
      let viaUrl = !localPath;
      // The tail window ends where the music stops, when the edges are known.
      const placement = embeddingOnly ? {} : analyzer.flatTailOpts(id, analyzer.tailWindowFor(db.getTrack(id)));
      const a = localPath
        ? await analyzer.analyzePathWithUrlFallback(id, localPath, {
            embed,
            vocal,
            complete: localComplete,
            stems_dir,
            stems_require_marker: stems_dir ? true : undefined,
            embedding_only: embeddingOnly || undefined,
            ...placement,
          }, () => { viaUrl = true; if (stems_dir) stemsWithoutSharedState += 1; })
        : await analyzer.analyze(id, {
            embed,
            vocal,
            stems_dir,
            stems_require_marker: stems_dir ? true : undefined,
            embedding_only: embeddingOnly || undefined,
            ...(placement.tail_window ? { tail_window: placement.tail_window } : {}),
          });
      let storedVocal = false;
      if (!embeddingOnly) {
        // Lyrics win over the worker's vocal output: a synced onset beats the
        // energy heuristic the worker returns once Demucs is skipped.
        const vocalRanges = lyricVocal ? lyricVocal.vocalRanges : a.vocalRanges;
        let outro = a.outro;
        if (lyricVocal && outro) {
          outro = { ...outro, vocalRanges: lyricTailRanges(id, outro, lyricVocal) };
        }
        if (stems_dir) stemsAsked += 1;
        if (stems_dir && a.stemsCached) stemsSaved += 1;
        const stemStamp = stemStampDecision({
          stemsCached: a.stemsCached,
          tailStems: a.tailStemsLanded ?? null,
          priorTailMisses: db.trackStemTailMisses(id),
        });
        db.upsertTrackAnalysis(id, {
          bpm: a.bpm,
          musicalKey: a.musicalKey,
          introMs: lyricVocal?.introMs != null ? lyricVocal.introMs : a.introMs,
          confidence: a.confidence,
          loudnessLufs: a.loudnessLufs,
          peakDb: a.peakDb,
          sections: a.sections,
          pace: a.paceCurve,
          beats: a.beats,
          bars: a.bars,
          keyRanges: a.keyRanges,
          vocalRanges,
          outro,
          // Every pass carries the stored tail ranges forward when its outro
          // came back without them: a vocal-off pass (planned or a plain
          // --re-analyze, #2255) never measured them, and a vocal-on pass
          // whose tail separation failed lost them (#2318). Either way the
          // tail half of the instrumental verdict holds. A tail measured with
          // its vocals (Demucs or lyrics) still replaces them.
          preserveTailVocal: true,
          leadSilenceMs: a.leadSilenceMs,
          tailSilenceMs: a.tailSilenceMs,
          tailStartMs: a.tailStartMs,
          tailVersion: a.tailPlaced ? db.placedTailVersion(outro, a.tailCurveUnavailable) : null,
          stemsAttempted: stemStamp.stamp,
          stemsTailMisses: stemStamp.tailMisses,
          // Recorded on the facet rows; 'capped' explains a missing tail.
          source: viaUrl
            ? 'url'
            : (localComplete === true ? 'full' : localComplete === false ? 'capped' : 'unknown'),
        });
        storedVocal = vocalRanges != null;
        // Surface the tail-vocal stuck case rather than retargeting it forever.
        if (a.outro == null && (lyricVocal != null || (vocal && a.vocalRanges != null))) {
          const prior = db.getTrack(id);
          if (prior?.outro && prior.outro.vocalRanges == null) {
            runlog.debug(`${id}: tail vocals not computable (incomplete download; stored outro predates tail detection), stays due`);
          }
        }
      }
      let storedAudio = false;
      if (a.audioEmbedding && a.audioEmbedding.length === db.AUDIO_EMBEDDING_DIM) {
        try {
          db.upsertTrackAudioVector(id, a.audioEmbedding);
          if (!audioMetaStamped) {
            db.setAudioEmbeddingMeta(audioModelLabel, db.AUDIO_EMBEDDING_DIM);
            audioMetaStamped = true;
          }
          storedAudio = true;
        } catch (err: any) {
          runlog.debug(`${id}: sounds-like vector write failed: ${err?.message || err}`);
        }
      }
      return { kind: 'analyzed', audioEmbedded: storedAudio, vocalAnalyzed: storedVocal };
    } finally {
      // Best-effort, regardless of outcome.
      if (localPath) await rm(localPath, { force: true }).catch(() => {});
    }
  };

  const commitOutcome = async (
    outcome: DispatchOutcome<TrackWorkResult>,
    id: string,
    index: number,
  ): Promise<void> => {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.kind === 'skipped') skippedTracks += 1;
      if (outcome.value.kind === 'analyzed') {
        analyzed += 1;
        if (outcome.value.audioEmbedded) audioEmbedded += 1;
        if (outcome.value.vocalAnalyzed) vocalAnalyzed += 1;
        // A success proves the buffered failures were about their files.
        flushFailureStamps();
        consecutiveFailures = 0;
      }
    } else {
      failed += 1;
      consecutiveFailures += 1;
      const err: any = outcome.reason;
      const reason = String(err?.message || err);
      runlog.debug(`${id} failed: ${reason}`);
      const plain = F.failureReason(reason);
      failureReasons.set(plain, (failureReasons.get(plain) ?? 0) + 1);
      if (failureCountsAgainstTrack(consecutiveFailures)) {
        pendingFailureStamps.push({ id, reason, ...(err instanceof OptInFailure ? { optIn: err.failed } : {}) });
      } else if (consecutiveFailures === SYSTEMIC_FAILURE_RUN + 1) {
        runlog.problem('warning', F.systemicFailureProblem(SYSTEMIC_FAILURE_RUN + 1, reason));
        pendingFailureStamps = [];
      }
    }
    const done = index + 1;
    orderedDone = done;
    // The run log's own cadence (F.progressDue); the panel's bar every 25.
    st.progress(done, ids.length);
    if (done % 25 === 0 || done === ids.length) {
      reportProgress({
        phase: 'analyze',
        label: 'Analysing audio',
        done,
        total: ids.length,
        errors: failed || undefined,
      });
    }
  };

  // A plan of whole-file facets alone runs in the sidecar's own lane (no
  // model, one CPU thread per file), so it may go wider than the analyze pool.
  const wholeFileLane = !!plan && useFacets && plan.items.length > 0 && plan.items.every(i => wholeFileOnly(i.id));
  const requestedConcurrency = wholeFileLane
    ? Math.min(config.analyzer.wholeFileConcurrency, analyzer.wholeFileConcurrency() ?? config.analyzer.wholeFileConcurrency)
    : config.analyzer.concurrency;
  const effectiveConcurrency = backend === 'sidecar' ? requestedConcurrency : 1;
  if (backend === 'local' && requestedConcurrency > 1) {
    runlog.debug(`ANALYZE_CONCURRENCY=${requestedConcurrency} applies to HTTP sidecars; local ANALYZE_PYTHON remains single-flight`);
  }

  // The step's header: what runs where, over what scope.
  const needs: Array<[string, number]> = plan
    ? plan.byFacet.filter(c => c.facet !== 'year').map(c => [F.PRODUCT[c.facet] ?? c.facet, c.planned])
    : [
        [`${F.PRODUCT.head}, ${F.PRODUCT.tail}`, bpmIds.length], [F.PRODUCT.clap, audioAdded],
        [F.PRODUCT.vocal, vocalAdded], [F.PRODUCT.stems, stemAdded],
      ];
  st.start({
    runsOn: F.runsOnAnalyzer({
      where: analysisBackendWhere(backend, analyzer.answeringBase()),
      lane: wholeFileLane ? 'cpu' : 'models',
      concurrency: effectiveConcurrency,
    }),
    scope: F.scopeProducts({ tracks: ids.length, pool: db.trackCount(), needs, from: runlog.runLog.originsOf(ids) }),
  });
  sayPending();

  if (effectiveConcurrency === 1) {
    // One-ahead prefetch, rejections settled immediately so none floats as an
    // unhandled rejection during the compute window.
    let inflight: Prefetch | null = prefetch(ids[0]);
    for (let i = 0; i < ids.length; i++) {
      await waitForQuiet(quietGate, { done: i, total: ids.length });
      const current = inflight;
      inflight = i + 1 < ids.length ? prefetch(ids[i + 1]) : null;
      let outcome: DispatchOutcome<TrackWorkResult>;
      try {
        outcome = { status: 'fulfilled', value: await runTrack(ids[i], current ?? undefined) };
      } catch (reason) {
        outcome = { status: 'rejected', reason };
      }
      await commitOutcome(outcome, ids[i], i);
    }
  } else {
    const admittedStems = new Map<number, { dir: string | undefined }>();
    await dispatchAnalysis(ids, {
      concurrency: effectiveConcurrency,
      beforeStart: async (index) => {
        await waitForQuiet(quietGate, { done: orderedDone, total: ids.length });
        // Reserve the pass-wide stem budget in source order, before the race.
        admittedStems.set(index, { dir: allocateStems(ids[index]) });
      },
      run: (id, index) => runTrack(id, undefined, admittedStems.get(index)),
      onOutcome: (outcome, id, index) => {
        admittedStems.delete(index);
        return commitOutcome(outcome, id, index);
      },
    });
  }

  // A trailing failure run shorter than the systemic threshold never met a
  // success, but nothing proved the pass unhealthy either, so those stamps land.
  flushFailureStamps();

  if (rangedTracks > 0) {
    runlog.debug(
      `ranged tail reads: ${rangedTracks} tracks, ${(rangedBytes / 1024 ** 2).toFixed(0)} MB fetched` +
        (rangedSize > 0 ? ` (${Math.round((rangedBytes / rangedSize) * 100)} % of their total size)` : ''),
    );
  }
  for (const [why, n] of fallbackReasons) {
    runlog.debug(`${n} track(s) fell back to the capped download: ${why}`);
  }
  if (stemsWithoutSharedState > 0) runlog.problem('warning', sharedStateNotice(stemsWithoutSharedState, config.stateRoot));

  // Best-effort sweep of the staging dir in case a prefetch left an orphan.
  await rm(`${config.stateRoot}/analyze-tmp`, { recursive: true, force: true }).catch(() => {});

  // Keep the stem cache inside the operator's byte budget after a pass that
  // may have written hundreds of new stem dirs (lowest stem-priority first —
  // NOT oldest first, or this pass's best writes would be the first evicted;
  // the hourly cleanup cron sweeps too, this just settles the bill promptly).
  if (passStems) {
    // New dirs can be added to the baseline. Rewrites and failed settlement
    // require a fresh walk, even if an old under-budget snapshot remains.
    const settled = await stemCacheStore.settlePassWrites(newStemIds, undefined, {
      rewroteExisting: rewroteExistingStems,
    }).catch(() => null);
    // With pick-time stems on, the dirs of tracks still in the queue go last,
    // as in the hourly sweep. This process has no live queue, so the set comes
    // from the queue's snapshot (pick-stems.ts sweepKeepLastFromDisk); off, it
    // is undefined and the order is the ranking alone.
    const swept = settled?.withinBudget
      ? null
      : await stemCacheStore.sweep(undefined, {
        force: true,
        keepLast: await sweepKeepLastFromDisk().catch(() => undefined),
      }).catch(() => null);
    if (swept && swept.removed > 0) {
      st.note(`Stems: ${F.fmtCount(swept.removed)} older stem sets removed to stay within the budget (${Math.round(swept.freedBytes / 1024 ** 2)} MB freed)`);
    }
    // The only place a stuck-over-budget cache reaches the event log (#1257).
    if (swept && swept.overBudgetBytes > 0) {
      runlog.problem(
        'warning',
        `The stems cache is ${(swept.overBudgetBytes / 1024 ** 3).toFixed(1)} GB over its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget and could not be trimmed back to it` +
          (swept.failedDirs ? `: ${swept.failedDirs} folder(s) could not be deleted. Check the ownership and permissions of the stems folder` : ''),
      );
    }
  }

  // The worker degrades silently when Demucs fails to load: every track reads
  // "ok" with vocal_ranges omitted, re-targeting the same tracks forever (#996).
  if (passVocal && analyzed > 0 && vocalAnalyzed === 0) {
    runlog.problem(
      'warning',
      'No vocal ranges were stored: Demucs probably failed to load on the analyzer. ' +
        'Look for "Demucs load failed" in the analyzer log, then restart the analyzer.',
    );
  }

  // The result: counts, the products written, and the failures by reason.
  for (const [reason, n] of [...failureReasons].sort((x, y) => y[1] - x[1]).slice(0, 3)) {
    st.note(`${F.fmtCount(n)} failed: ${reason}`);
  }
  const left = skippedTracks > 0
    ? { count: skippedTracks, why: stemsShareMissing ? 'their stems wait for the stems share' : 'nothing could be asked of them this run' }
    : undefined;
  // Stems refused on a track whose other work was done: the step is partial.
  const shareMissing = !left ? stemsNotSaved : 0;
  st.done({
    summary: F.analysisSummary({
      done: analyzed, failed, left,
      products: [[F.PRODUCT.clap, audioEmbedded], [F.PRODUCT.vocal, vocalAnalyzed]],
      stems: { asked: stemsAsked, saved: stemsSaved, shareMissing },
    }),
    outcome: shareMissing ? 'partial' : F.outcomeOf({ done: analyzed, failed, left }),
  });

  // Zero-shot audio moods and sound descriptors over the vectors this and past
  // passes wrote; no-op when there is nothing new or the backend has no text
  // tower. A step that wrote no vector skips it (scoreAudio false).
  if (opts.scoreAudio !== false) await scoreAudioMoods();

  return { available: true, backend, analyzed, failed, scope: ids.length, audioEmbedded, vocalAnalyzed };
}
