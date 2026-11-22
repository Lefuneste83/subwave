// Hold the unsent tail until its successor is known or the hard deadline requires intrinsic
// stamps. Pick the successor early enough for selection and a cached stem render. #749,
// scripts/drain-policy.test.ts..
import { safeCrossSec } from '../music/safe-out-policy.js';

export const DRAIN_DEADLINE_SEC = 120;

// Past this the held item is sent with track-intrinsic stamps only: Liquidsoap
// needs the next track resolved well before the crossfade. Never risk dead air
// for a prettier seam.
export const HARD_DEADLINE_SEC = 45;

// Minimum gap between deadline-pick ATTEMPTS. The watcher re-enters every 1.5s,
// so without this a fast-failing pick re-fires ~50 times per window. A
// successful pick self-limits, so this only meters failures.
export const DEADLINE_PICK_COOLDOWN_SEC = 25;

// Effective on-air span: [cue_in, min(duration, cue_out)]. Cue values are
// absolute file offsets while startedAt is stamped at cue_in, so the skipped
// head must not count toward the remaining clock.
export function playableDurationSec(
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  if (dur == null) return null;
  const cueOut = typeof cueOutSec === 'number' && Number.isFinite(cueOutSec) && cueOutSec > 0 ? cueOutSec : null;
  const cueIn = typeof cueInSec === 'number' && Number.isFinite(cueInSec) && cueInSec > 0 ? cueInSec : 0;
  return Math.max(0, Math.min(dur, cueOut ?? dur) - cueIn);
}

// Seconds left before the on-air track's EFFECTIVE end (playable span after
// both cue points), so a capped or trimmed track ends when Liquidsoap does.
// Null when unknowable; callers treat null as "cannot schedule" and drain
// eagerly.
export function remainingSec(
  nowMs: number,
  startedAtMs: number | null | undefined,
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;
  const playable = playableDurationSec(durationSec, cueOutSec, cueInSec);
  if (playable == null) return null;
  return (startedAtMs + playable * 1000 - nowMs) / 1000;
}

// WHERE THE WINDOW ENDS. `cross` reaches for the next track when the
// transition OUT of the track ahead begins, not at its end: it buffers that
// track's own end, which radio.liq's cross_stamps sizes from the outgoing
// track's stamps alone (a Hot Mix seam's lead plus the clip slack, a safe
// transition's two bars plus its lead plus the slack). A track committed after
// that instant misses the seam and the coast (auto.m3u) airs in its place, so
// every pre-commit wait for a track coming out of such a seam is measured to the
// seam's start. On air, a Hot Mix lead of about 32 s let a slow intro render
// commit the planned partner 17-22 s after the mixer had switched to the coast.
//
// Only the controller-planned Hot Mix overlaps (the beat-matched seam and the
// safe transition) are subtracted. A plain crossfade runs on the same `cross`
// mechanism, but its window keeps the end-of-track clock it always had: a
// shorter window there would change every non-Hot-Mix station.
//
// radio.liq clip_seam_slack: what cross_stamps buffers past either Hot Mix lead.
export const MIXER_SEAM_SLACK_SEC = 0.1;
// Once the track is committed, the mixer still needs it ready before the seam:
// next.txt is polled once a second, then request.queue resolves the request (a
// local file opens at once, a stream is downloaded whole by proto_subhttp
// first). Not measured: a margin, so the planned partner is ready a little
// ahead of the instant the mixer asks for it rather than exactly at it.
export const SEAM_HANDOFF_MARGIN_SEC = 3;

// The seam OUT of the track ahead, as the mixer will size it: the overlap
// before that track's end at which `cross` asks for the next one. Zero when the
// track ahead carries no Hot Mix overlap (a plain crossfade, see above), or is
// unknown.
export function seamOverlapSec(ahead: {
  mixOut?: { leadSec: number } | null;
  safeOut?: { barSec: number; leadSec: number } | null;
} | null | undefined): number {
  const lead = ahead?.mixOut?.leadSec;
  if (typeof lead === 'number' && Number.isFinite(lead) && lead > 0) return lead + MIXER_SEAM_SLACK_SEC;
  const safe = ahead?.safeOut;
  if (safe && Number.isFinite(safe.barSec) && Number.isFinite(safe.leadSec) && safe.barSec > 0 && safe.leadSec > 0) {
    return safeCrossSec(safe) + MIXER_SEAM_SLACK_SEC;
  }
  return 0;
}

// Seconds left before the mixer needs the track: the end-of-track clock less
// the seam's overlap and the handoff margin. Null stays null (unknowable), and
// no overlap leaves the clock untouched. Negative means the seam has begun.
export function seamWindowSec(remainingToEnd: number | null, overlapSec: number | null | undefined): number | null {
  if (remainingToEnd == null) return null;
  if (typeof overlapSec !== 'number' || !Number.isFinite(overlapSec) || overlapSec <= 0) return remainingToEnd;
  return remainingToEnd - overlapSec - SEAM_HANDOFF_MARGIN_SEC;
}

// Runway kept for the commit tail after the intro render in one drain pass:
// the bed and track handoff writes (up to 5s each), the loudness lookup and the
// annotate. The pre-render must never eat into it.
export const DRAIN_COMMIT_RESERVE_SEC = 12;

// Below this there is no honest render window left — starting a TTS call that
// cannot finish only delays the music commit for a WAV nobody will use.
export const MIN_PRERENDER_BUDGET_SEC = 5;

// Intro pre-render budget: null is unbounded when air time is unknown; zero skips pre-render;
// positive values bound the wait. airIntro can render the script later without delaying music.
// #1409.
export function introRenderBudgetSec(remaining: number | null): number | null {
  if (remaining == null) return null;
  const budget = remaining - DRAIN_COMMIT_RESERVE_SEC;
  return budget >= MIN_PRERENDER_BUDGET_SEC ? budget : 0;
}

// The cue-landing probe's own ceiling (#2003): one ffprobe read of Y around its cue.
export const CUE_PROBE_TIMEOUT_MS = 2000;

// The mount check's own ceiling (#2222): one `path_readable` round trip about the
// pick's file. radio.liq bounds its own test at 1 s on a hung mount, so this is a
// little over that, and a slow but honest answer still counts.
export const MOUNT_CHECK_TIMEOUT_MS = 1500;

// What a question asked between the intro render and Y's next.txt write may spend,
// in ms: what the commit reserve leaves, capped at the question's own ceiling. An
// unknown clock gets the ceiling, and zero skips the question.
function preCommitBudgetMs(remaining: number | null, ceilingMs: number): number {
  if (remaining == null) return ceilingMs;
  const budgetMs = Math.floor((remaining - DRAIN_COMMIT_RESERVE_SEC) * 1000);
  return budgetMs > 0 ? Math.min(ceilingMs, budgetMs) : 0;
}

// Cue-landing probe budget, in ms. Zero skips the probe: no stamp, and the
// clip -> Y seam aligns on the cue as it did before the probe existed.
export function cueProbeBudgetMs(remaining: number | null): number {
  return preCommitBudgetMs(remaining, CUE_PROBE_TIMEOUT_MS);
}

// The Hot Mix beat-phase check's ceiling (music/percussion-phase.ts): two
// ffmpeg decodes in parallel, the outgoing one sequential from its first
// sample (about 2-3 s on a local file, a download over HTTP). Zero skips the
// check: the seam aligns on the two grids.
export const BEAT_PHASE_TIMEOUT_MS = 10_000;

export function beatPhaseBudgetMs(remaining: number | null): number {
  return preCommitBudgetMs(remaining, BEAT_PHASE_TIMEOUT_MS);
}

// Budget for asking the mixer whether it can read the pick's own file, in ms
// (music/library-mount.ts mixerReadablePath). Zero asks nothing and the pick
// streams, the side that never loses the music.
export function mountCheckBudgetMs(remaining: number | null): number {
  return preCommitBudgetMs(remaining, MOUNT_CHECK_TIMEOUT_MS);
}

type DrainAction = 'send-pair' | 'send-intrinsic' | 'hold';

// A successor releases the held item with pair stamps, including a listener request; preserve
// FIFO. Without a successor, hold until the deadline or send intrinsic stamps when timing is
// unavailable.
export function drainAction(opts: {
  pairDrain: boolean;
  hasSuccessor: boolean;
  remainingSec: number | null;
}): DrainAction {
  if (opts.hasSuccessor) return opts.pairDrain ? 'send-pair' : 'send-intrinsic';
  if (!opts.pairDrain) return 'send-intrinsic';
  if (opts.remainingSec == null) return 'send-intrinsic';
  if (opts.remainingSec < HARD_DEADLINE_SEC) return 'send-intrinsic';
  return 'hold';
}

// Whether the deadline routine fires the successor pick this tick: inside the
// deadline window and not past the hard deadline, which owns the endgame.
export function shouldDeadlinePick(remaining: number | null): boolean {
  return remaining != null && remaining < DRAIN_DEADLINE_SEC && remaining >= HARD_DEADLINE_SEC;
}
