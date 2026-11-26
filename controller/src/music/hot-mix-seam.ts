// DJ Hot Mix seams: how one pair of tracks is beat-mixed (radio.liq, HOT MIX
// SEAMS). Pure: grids and numbers in, a plan (or the reason there is none) out.
// broadcast/queue.ts asks once per pair, when the outgoing track is drained
// with its successor known, and stamps the plan on both tracks.
//
// Who moves (the operator's rule, mix-design.md §2e). Below the sync limit,
// which is the show's own step (the gap the picker keeps, default 3 %), only
// the INCOMING track is synced to the outgoing one: the outgoing track plays
// untouched, as a DJ leaves it. Up to twice that, the gap is split: the
// outgoing track also ramps over its last bars, halfway in tempo, so neither
// moves more than the limit. Past that no beat mix sounds smooth, and the seam
// is the station's ordinary crossfade. The limit itself never exceeds
// SYNC_MAX_PCT, whatever the step: a 20 % step is a picker setting, never a
// stretch.
//
// Where. The incoming track starts on its first downbeat, at a downbeat of the
// outgoing one, and the outgoing track is cut `overlapBeats` later (the show's
// phrase length; OVERLAP_BEATS, eight bars, by default), on a bar line, so both
// fade over the same bars (the overlap, `leadSec`). The
// incoming one holds the outgoing tempo while that lasts, then glides back to
// its own over GLIDE_SEC. Every window sits inside ONE grid segment whose
// period agrees with the track's tempo: a seam laid across a segment change,
// or on a double-time stretch of the grid, has no beat to trust, and gets the
// plain crossfade instead.
//
// A phrase window (music/phrase-mix-policy.ts, a show's `phraseMix`) names both
// downbeats instead of searching for them: the outgoing track's overlap starts
// on the downbeat at `aStartSec`, and the incoming one on its downbeat at
// `bEntrySec`, past the 30 s cue-in search (the window skips its intro on
// purpose, within phrase-mix-policy's own depth guards). Every other rule
// stands, and a window the grids do not hold is refused, never moved: the
// caller then searches as before. Its
// structure counts four-beat bars of the incoming track's own beat, so an
// incoming tempo folded an octave would put its first hard kick off the cut,
// and is refused too; otherwise that kick plays exactly `leadSec` after the
// incoming track starts (`bPunchSec`).
//
// Timelines. Liquidsoap stretches by OUTPUT seconds since the track started
// (the factor is a function of what the stretch has emitted, never of input
// time, which soundtouch reads ahead). An outgoing track that was itself the
// incoming side of the previous seam starts stretched, so its downbeats sit
// later in output time than in its file: `profileOf` and `outAt` replay that
// rule exactly, so the ramp and the overlap land where the mixer will play
// them.
import type { GridSegment } from './library-db/grid.js';

export const SYNC_MAX_PCT = 6;
export const OVERLAP_BEATS = 32;
export const RAMP_BEATS = 16;
export const GLIDE_SEC = 16;
// The incoming track's first usable downbeat must come within this of where
// it would otherwise start: past it the seam would skip the record's opening.
export const IN_DOWNBEAT_MAX_SEC = 30;
// A phrase window's times (structure bars, stored to the ms) find their grid
// downbeat within this.
export const WINDOW_MATCH_SEC = 0.03;
// A segment's period must agree with the track's tempo to within this.
const PERIOD_AGREE = 0.01;
// The mixer refuses a factor outside [0.85, 1.15]; stay well inside it.
const FACTOR_MIN = 0.88;
const FACTOR_MAX = 1.12;

// The stamps of one track's tempo, in output seconds since it started.
export interface StartStretch { tempo: number; holdSec: number; glideSec: number }
export interface EndStretch { tempo: number; fromSec: number; rampSec: number }

export interface SeamSide {
  segments: GridSegment[];
  beatsPerBar: number | null;
  bpm: number | null;
}

// File seconds of the two downbeats a phrase window names.
export interface SeamWindow { aStartSec: number; bEntrySec: number }

export interface SeamInput {
  stepPct: number;
  overlapBeats?: number;        // the overlap, in beats of A (default OVERLAP_BEATS)
  window?: SeamWindow | null;   // a phrase window: both downbeats named
  a: SeamSide & {
    cueInSec: number;           // where the outgoing track started (its own trim)
    endSec: number;             // its effective end: duration, trim, cap
    start: StartStretch | null; // its own start stretch, if it was mixed in
  };
  b: SeamSide & {
    cueInSec: number;           // where the incoming track would start (its trim)
    durationSec: number;
  };
}

export interface SeamPlan {
  kind: 'incoming' | 'split';
  gapPct: number;
  aBpm: number;
  bBpm: number;
  outCueSec: number;  // A's liq_cue_out, on a bar line
  inCueSec: number;   // B's liq_cue_in, a downbeat
  leadSec: number;    // the overlap, output seconds
  bStart: StartStretch;
  aEnd: EndStretch | null;
  // The grid beats each side plays through the overlap, in file seconds: what
  // the beat-phase check (music/percussion-phase.ts) measures.
  aOverlapBeats: number[];
  bOverlapBeats: number[];
  // With a phrase window: output seconds after B starts at which its first
  // hard kick plays, which is where A is cut (leadSec, by construction).
  bPunchSec?: number;
}

export type SeamVerdict = { ok: true; plan: SeamPlan } | { ok: false; reason: string };

// ─── Tempo profile: radio.liq's hot_mix_tempo, replayed ─────────────────────

// Breakpoints (output second, factor), linear between them, the last held.
type Profile = Array<{ e: number; f: number }>;

export function profileOf(start: StartStretch | null, end: EndStretch | null): Profile {
  const p: Profile = [{ e: 0, f: 1 }];
  if (start && start.tempo !== 1) {
    p[0] = { e: 0, f: start.tempo };
    p.push({ e: start.holdSec, f: start.tempo });
    p.push({ e: start.holdSec + Math.max(0, start.glideSec), f: 1 });
  }
  if (end && end.tempo !== 1) {
    const last = p[p.length - 1].e;
    if (end.fromSec > last) p.push({ e: end.fromSec, f: 1 });
    p.push({ e: Math.max(end.fromSec, last) + Math.max(0, end.rampSec), f: end.tempo });
  }
  return p;
}

// Source seconds advanced after `e` output seconds.
export function srcAt(p: Profile, e: number): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (!b) return s + (e - a.e) * a.f;
    if (e <= b.e) {
      const x = e - a.e;
      const slope = b.e > a.e ? (b.f - a.f) / (b.e - a.e) : 0;
      return s + a.f * x + (slope * x * x) / 2;
    }
    s += ((a.f + b.f) / 2) * (b.e - a.e);
  }
  return s;
}

// Output seconds at which `src` source seconds have played: srcAt's inverse.
export function outAt(p: Profile, src: number): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    const span = b ? ((a.f + b.f) / 2) * (b.e - a.e) : Infinity;
    if (src <= s + span) {
      const need = src - s;
      const slope = b && b.e > a.e ? (b.f - a.f) / (b.e - a.e) : 0;
      if (Math.abs(slope) < 1e-12) return a.e + need / a.f;
      // a.f x + slope x² / 2 = need
      return a.e + (-a.f + Math.sqrt(a.f * a.f + 2 * slope * need)) / slope;
    }
    s += span;
  }
  return Infinity;
}

// ─── Grids ──────────────────────────────────────────────────────────────────

export const periodOf = (seg: GridSegment) => seg.periodUs / 1e6;
export const segStart = (seg: GridSegment) => seg.anchorMs / 1000;
const segEnd = (seg: GridSegment) => segStart(seg) + (seg.beats - 1) * periodOf(seg);

// Segments whose beat is the track's beat, with a known bar phase.
export function trustedSegments(side: SeamSide): GridSegment[] {
  if (!side.bpm || side.bpm <= 0) return [];
  const main = 60 / side.bpm;
  return side.segments.filter((seg) => seg.downbeatMs != null && seg.beats >= 8 && seg.periodUs > 0
    && Math.abs(periodOf(seg) / main - 1) <= PERIOD_AGREE);
}

// Downbeats of a segment, in file seconds, ascending.
export function downbeats(seg: GridSegment, beatsPerBar: number): number[] {
  const p = periodOf(seg);
  const db = seg.downbeatMs! / 1000;
  const first = db - Math.floor((db - segStart(seg)) / (p * beatsPerBar) + 1e-9) * p * beatsPerBar;
  const out: number[] = [];
  for (let t = first; t <= segEnd(seg) + 1e-6; t += p * beatsPerBar) out.push(t);
  return out;
}

// B's tempo folded to the octave nearest A's: 64 BPM against 128 reads as 128.
function foldTo(bpm: number, ref: number): number {
  let x = bpm;
  while (x / ref > Math.SQRT2) x /= 2;
  while (ref / x > Math.SQRT2) x *= 2;
  return x;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// ─── The plan ───────────────────────────────────────────────────────────────

export function planHotMixSeam(input: SeamInput): SeamVerdict {
  const syncPct = Math.min(Math.max(0, input.stepPct), SYNC_MAX_PCT);
  const aSegs = trustedSegments(input.a);
  const bSegs = trustedSegments(input.b);
  if (!aSegs.length) return { ok: false, reason: 'no trusted beat grid on the outgoing track' };
  if (!bSegs.length) return { ok: false, reason: 'no trusted beat grid on the incoming track' };
  const aBar = input.a.beatsPerBar && input.a.beatsPerBar > 0 ? input.a.beatsPerBar : 4;
  const bBar = input.b.beatsPerBar && input.b.beatsPerBar > 0 ? input.b.beatsPerBar : 4;
  const overlapBeats = input.overlapBeats && input.overlapBeats > 0 ? Math.round(input.overlapBeats) : OVERLAP_BEATS;
  const win = input.window ?? null;

  // The incoming side first: its trusted downbeats at or after its cue-in,
  // within IN_DOWNBEAT_MAX_SEC, earliest first, or the window's own. Each is
  // tried in turn and the first whose plan stands is taken: a beat tracker
  // often splits an intro into a short first segment (10-30 beats) before the
  // main one, so the first downbeat cannot hold the overlap in its segment
  // while the main segment's, a few seconds on, can (12 of the 35 unsynced
  // seams in Hot Mix shows, 16-19 Nov). The first candidate that plans is the
  // one the seam always took, so a seam planned before is planned the same.
  const bCue = Math.max(0, input.b.cueInSec);
  const picks: Array<{ seg: GridSegment; at: number }> = [];
  for (const seg of bSegs) {
    if (win) {
      const at = downbeats(seg, bBar).find((t) => Math.abs(t - win.bEntrySec) <= WINDOW_MATCH_SEC + 1e-9);
      if (at != null && (!picks.length || Math.abs(at - win.bEntrySec) < Math.abs(picks[0].at - win.bEntrySec))) picks.splice(0, 1, { seg, at });
      continue;
    }
    for (const at of downbeats(seg, bBar)) {
      if (at >= bCue - 1e-6 && at - bCue <= IN_DOWNBEAT_MAX_SEC) picks.push({ seg, at });
    }
  }
  if (!picks.length) {
    return { ok: false, reason: win ? 'the phrase window\'s incoming downbeat is not on a trusted grid' : 'no downbeat near the incoming track\'s start' };
  }
  picks.sort((x, y) => x.at - y.at);

  // The outgoing tempo at its end: the last trusted segment before its end.
  const aEnd = input.a.endSec;
  const aSegsBefore = aSegs.filter((seg) => segStart(seg) < aEnd).sort((x, y) => segStart(y) - segStart(x));
  if (!aSegsBefore.length) return { ok: false, reason: 'no trusted beat grid before the outgoing track\'s end' };

  let first: SeamVerdict | null = null;
  for (const bPick of picks) {
    const v = planFrom(bPick);
    if (v.ok) return v;
    first ??= v;
  }
  return first!;

  function planFrom(bPick: { seg: GridSegment; at: number }): SeamVerdict {
  const pB = periodOf(bPick.seg);
  const bBpmNative = 60 / pB;
  for (const aSeg of aSegsBefore) {
    const pA = periodOf(aSeg);
    const aBpm = 60 / pA;
    const bBpm = foldTo(bBpmNative, aBpm);
    const gapPct = (bBpm / aBpm - 1) * 100;
    const kind: SeamPlan['kind'] | null = Math.abs(gapPct) <= syncPct + 1e-9
      ? 'incoming'
      : Math.abs(gapPct) <= 2 * syncPct + 1e-9 ? 'split' : null;
    if (!kind) return { ok: false, reason: `tempo gap ${round(gapPct, 1)} % is past twice the ${syncPct} % sync limit` };
    if (win && Math.abs(bBpm / bBpmNative - 1) > 1e-9) {
      return { ok: false, reason: 'the phrase window\'s incoming tempo is an octave from the outgoing one: its bars are not the outgoing one\'s' };
    }
    // Factors: the outgoing track ends at q, the incoming one starts at r, and
    // both then play one beat every pA / q output seconds.
    const q = kind === 'split' ? Math.sqrt(bBpm / aBpm) : 1;
    const pBfold = 60 / bBpm;
    const r = (q * pBfold) / pA;
    if (r < FACTOR_MIN || r > FACTOR_MAX || q < FACTOR_MIN || q > FACTOR_MAX) {
      return { ok: false, reason: 'stretch past the mixer\'s range' };
    }
    const overlapSrc = overlapBeats * pA;
    const leadSec = overlapSrc / q;
    const rampOut = kind === 'split' ? RAMP_BEATS * pA : 0;
    const rampSrc = rampOut * (1 + q) / 2;
    const startProfile = profileOf(input.a.start, null);
    const startDoneOut = startProfile[startProfile.length - 1].e;
    // The latest downbeat D of this segment whose window fits: the ramp and
    // the overlap inside the segment, the cut before the track's end, the ramp
    // after the outgoing track's own start stretch.
    // A window names its D: the one downbeat at its start, or none here.
    const dbs = downbeats(aSeg, aBar).reverse()
      .filter((D) => !win || Math.abs(D - win.aStartSec) <= WINDOW_MATCH_SEC + 1e-9);
    for (const D of dbs) {
      if (D + overlapSrc > aEnd + 1e-6) continue;
      if (D + overlapSrc > segEnd(aSeg) + pA + 1e-6) continue;
      if (D - rampSrc < segStart(aSeg) - 1e-6) break;
      const relD = D - input.a.cueInSec;
      if (relD - rampSrc <= 0) break;
      let end: EndStretch | null = null;
      if (kind === 'split') {
        const fromSec = outAt(startProfile, relD - rampSrc);
        if (!Number.isFinite(fromSec) || fromSec < startDoneOut) break;
        end = { tempo: round(q, 6), fromSec: round(fromSec, 4), rampSec: round(rampOut, 4) };
      } else if (outAt(startProfile, relD) < startDoneOut) {
        break;
      }
      // The incoming track must outlast the hold and the glide.
      const bNeedsSrc = leadSec * r + GLIDE_SEC;
      if (input.b.durationSec > 0 && bPick.at + bNeedsSrc > input.b.durationSec) {
        return { ok: false, reason: 'the incoming track is too short for the mix' };
      }
      if (bPick.at + leadSec * r > segEnd(bPick.seg) + pB + 1e-6) {
        return { ok: false, reason: 'the incoming track\'s grid changes inside the overlap' };
      }
      return {
        ok: true,
        plan: {
          kind,
          gapPct: round(gapPct, 2),
          aBpm: round(aBpm, 2),
          bBpm: round(bBpmNative, 2),
          outCueSec: round(D + overlapSrc, 4),
          inCueSec: round(bPick.at, 4),
          leadSec: round(leadSec, 4),
          bStart: { tempo: round(r, 6), holdSec: round(leadSec, 4), glideSec: GLIDE_SEC },
          aEnd: end,
          aOverlapBeats: Array.from({ length: overlapBeats + 1 }, (_, k) => round(D + k * pA, 4)),
          bOverlapBeats: Array.from({ length: Math.floor((leadSec * r) / pB) + 1 }, (_, k) => round(bPick.at + k * pB, 4)),
          ...(win ? { bPunchSec: round(leadSec, 4) } : {}),
        },
      };
    }
  }
  return {
    ok: false,
    reason: win
      ? 'the phrase window\'s outgoing downbeat is not on a trusted grid, or its overlap does not fit there'
      : 'no downbeat window for the overlap in the outgoing track\'s grid',
  };
  }
}

// Each side's stamps, as getAnnotatedUri writes them (radio.liq reads these
// names). `id` ties the pair: the mixer applies B's start only after the A
// that names it.
export interface MixOutStamps {
  id: string; leadSec: number; end: EndStretch | null;
  // A phrase-mix seam: the outgoing bass ridden down over the overlap
  // (radio.liq HOT MIX BASS MOVE reads it as liq_mix_bass="ride").
  bassRide?: { fromSec: number; toSec: number };
  // The bass pots (music/bass-pot-policy.ts), on a mixer that has them: the
  // outgoing bass tamed down over `buildSec` output seconds before the swap
  // (liq_mix_bass="build", liq_mix_build). Written instead of `bassRide`.
  bassBuild?: { buildSec: number };
}
export interface MixInStamps extends StartStretch {
  id: string;
  // Output seconds after B starts at which its bass swaps in (liq_mix_punch):
  // the downbeat at the outgoing end, which on a phrase-mix seam is its first
  // hard kick.
  punchSec?: number;
}

// The punch once the beat phase has moved B's cue-in (shiftInCue): B's audio,
// and its first hard kick with it, moves by the file seconds its start moved,
// at B's opening tempo r. A shift the cue could not take is waited in the
// mixer (`waitSec`, file seconds), which is the cue starting that much earlier.
export function punchAfterShift(punchSec: number, plannedInCueSec: number, inCueSec: number, waitSec: number, r: number): number {
  const moved = (inCueSec - waitSec) - plannedInCueSec;
  return Math.round((punchSec - moved / (r > 0 ? r : 1)) * 1e4) / 1e4;
}

// ─── The incoming side at handoff ───────────────────────────────────────────

// B's cue-in once the beat phase has moved it. The cue cannot go before the
// file's first sample, and a downbeat there is common (an extended mix opens
// on its kick): what the cue cannot absorb becomes `waitSec`, file seconds B
// starts too early, which the mixer turns into a wait like a late codec-frame
// landing (liq_mix_cue_late) rather than the correction being lost.
export function shiftInCue(inCueSec: number, shiftSec: number): { inCueSec: number; waitSec: number } {
  const want = inCueSec + shiftSec;
  if (want >= 0) return { inCueSec: Math.round(want * 10000) / 10000, waitSec: 0 };
  return { inCueSec: 0, waitSec: Math.round(-want * 1e6) / 1e6 };
}

// Whether the seam into B still stands at its handoff, and what it stamps.
// It stands while B starts on the downbeat it was planned on. No cue-in is a
// start at 0 s: the queue keeps only positive cues, so a downbeat at the top
// of the file arrives as `cueInSec` absent, and is the planned start all the
// same. `probedLateSec` is the codec-frame landing measured for this cue (none
// for a start at 0 s, which decodes from its first sample).
export function incomingStamps(
  mixIn: (MixInStamps & { inCueSec: number; waitSec?: number }) | null | undefined,
  cueInSec: number | null | undefined,
  probedLateSec: number | null,
): { mixIn: MixInStamps | null; cueLateSec: number | null } {
  if (!mixIn || (cueInSec ?? 0) !== mixIn.inCueSec) return { mixIn: null, cueLateSec: null };
  const late = (probedLateSec ?? 0) + (mixIn.waitSec ?? 0);
  return { mixIn, cueLateSec: late !== 0 ? Math.round(late * 1e6) / 1e6 : null };
}
