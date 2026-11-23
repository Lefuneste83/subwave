// Pure decisions the analysis pass makes about what it skips, and what it tells
// the operator when it does. Side-effect-free so they can be unit-pinned
// (scripts/analyze-capability.test.ts). The messages are the contract: this is
// the only place an operator with a broken analyzer finds out what broke.

import { modelProblem } from './run-log-format.js';

type AnalysisDimension = 'audio' | 'vocal' | 'stem';

// Which backend is answering, so the retry advice names something that exists.
// 'sidecar' has an analyzer container; 'local' (librosa venv, every AIO image)
// runs the worker as a child of the controller.
type AnalysisBackend = 'sidecar' | 'local' | string | null;

// Consecutive failures after which a track leaves automatic analysis scopes.
// A single failure is usually transient; explicit retries can bypass this.
export const MAX_ANALYSIS_FAILURES = 3;

export function analysisRetryAllowed(attempts: number): boolean {
  return attempts < MAX_ANALYSIS_FAILURES;
}

// SQL counterpart for scopes that read the legacy tracks columns.
export function analysisFailureExclusion(alias = ''): string {
  const col = alias ? `${alias}.analyze_fail_count` : 'analyze_fail_count';
  return `COALESCE(${col}, 0) < ${MAX_ANALYSIS_FAILURES}`;
}

// Older sidecars can measure head vocals without knowing how to measure tails.
export function tailVocalBackfillAvailable(capable: boolean | null): boolean {
  return capable === true;
}

export interface CapabilityInputs {
  dimension: AnalysisDimension;
  // The operator wants this dimension (env force or the admin toggle).
  wanted: boolean;
  // Backend can emit it. false = definitively not; null = unknown (a local
  // backend that hasn't been probed, or a sidecar too old to advertise).
  capable: boolean | null;
  // Set when `capable` is false because the model LOAD failed rather than the
  // build being lean. null otherwise, including on a lean image.
  error: string | null;
  // analyzer.backendLabel(). Only affects the retry sentence; omitting it gives
  // generic wording.
  backend?: AnalysisBackend;
}

export interface CapabilityDecision {
  // Widen the pass to already-analysed tracks missing this dimension. False
  // when the backend definitively can't produce it, since widening would then
  // re-analyse the whole library every pass for a guaranteed no-op.
  widen: boolean;
  // One line for the pass log, or null when there is nothing to say.
  notice: string | null;
}

// What the dimension gives the station, and the model it needs, in the
// operator's terms. Vocal ranges and the stem cache are the same Demucs
// separation, so they fail together.
const PRODUCT: Record<AnalysisDimension, string> = {
  audio: 'Sounds-like fingerprint',
  vocal: 'Vocals',
  stem: 'Stems for blends',
};

const MODEL: Record<AnalysisDimension, string> = {
  audio: 'CLAP',
  vocal: 'Demucs',
  stem: 'Demucs',
};

// The notice is the run log's model problem (run-log-format.ts modelProblem):
// the model, the analyzer's own message shortened, and the fix. A model that
// failed to load is remembered by whatever runs it (the analyzer container's
// capability latch; the controller's own module state on a local/AIO
// install), so the fix names that restart.
export function backfillDecision(x: CapabilityInputs): CapabilityDecision {
  if (!x.wanted) return { widen: false, notice: null };
  if (x.capable !== false) return { widen: true, notice: null };
  return {
    widen: false,
    notice: modelProblem({
      product: PRODUCT[x.dimension], model: MODEL[x.dimension], error: x.error, backend: x.backend ?? null,
    }),
  };
}

// Tracks pulled in only because their CLAP vector is missing skip the baseline
// acoustic pass. Any baseline/vocal/stem scope membership keeps the full path;
// audioBackfill is explicit so ordinary analysis never becomes embedding-only.
export function analysisModeForTrack(
  id: string,
  fullAnalysisIds: ReadonlySet<string>,
  audioBackfill: boolean,
): 'full' | 'embedding-only' {
  return audioBackfill && !fullAnalysisIds.has(id) ? 'embedding-only' : 'full';
}

// How many tracks in a row may fail before the pass stops treating a throw as
// evidence about the file rather than about the system (a dead analyzer, an
// absent music backend, an unmounted volume).
export const SYSTEMIC_FAILURE_RUN = 5;

// Whether a thrown analysis should count against MAX_ANALYSIS_FAILURES. The
// per-track stamp exists so a permanently unanalysable file leaves the scope;
// it is the wrong instrument for a systemic outage, which throws for every
// remaining track.
//
// `consecutive` = failures since the last success in this pass, including the
// one being decided, so scattered bad files never build a run. A true answer
// means "this MAY be about the file": the caller BUFFERS the stamp and writes it
// only once a later success proves the pass healthy, discarding it if the run
// trips the threshold. Stamping eagerly would sentence tracks in id order on
// every pass of a persistent outage, and an excluded track cannot self-heal.
export function failureCountsAgainstTrack(consecutive: number): boolean {
  return consecutive <= SYSTEMIC_FAILURE_RUN;
}
