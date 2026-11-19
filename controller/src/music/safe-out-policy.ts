// DJ Hot Mix safe transition (pure): what a Hot Mix show airs when a seam
// cannot be beat-matched (a tempo gap past twice the step, no trusted grid,
// no downbeat near the incoming start, a coast track whose successor is not
// known). Two unsynced kicks overlapping is the one thing the show must never
// air, so the overlap carries no outgoing bass: the outgoing track plays on to
// one of its bar lines, its bass pot goes to its minimum in 140 ms just
// before the incoming track enters at full on its first downbeat AT that bar
// line, and the outgoing highs fade over one bar after it. Chosen by the
// operator's blind set 5 (mix-design §2m): acceptable on all three pairs,
// against 2 for an echo out, 1 for a quick cut and 1 for the plain crossfade
// as it aired; the pot's single cut then replaced a two-bar bass ride (§2o).
//
// Times are file seconds, which are output seconds at a track's end: the safe
// transition stretches nothing, and a track mixed in has glided back to its
// own tempo long before its end. radio.liq's HOT MIX SAFE OUT reads the plan as
// two stamps on the outgoing track: `liq_safe_out` (its bar, seconds) and
// `liq_safe_lead` (from the incoming track's first sample to the outgoing end:
// one bar plus the incoming pre-roll); the buffer is two bars more.
import { downbeats, IN_DOWNBEAT_MAX_SEC, periodOf, segStart, trustedSegments } from './hot-mix-seam.js';
import type { GridSegment } from './library-db/grid.js';

// The incoming track starts this far before its downbeat, so a cue-in landing
// a codec frame late (up to ~93 ms, liquidsoap/CLAUDE.md CUE-IN LANDING) still
// plays its first kick whole.
export const PRE_ROLL_SEC = 0.1;
// No grid and no usable tempo tag: a bar of 120 BPM.
export const FALLBACK_BAR_SEC = 2;
// The bars buffered before the bar line: once the bass ride, now the outgoing
// track played on before its pot's cut. The mixer's buffer counts them.
export const RIDE_BARS = 2;

export interface SafeSide {
  segments?: GridSegment[] | null;
  beatsPerBar?: number | null;
  bpm?: number | null;
}
export interface SafeInput {
  a: SafeSide & { endSec: number; cueInSec?: number | null };
  // The incoming side is optional: a coast track's successor is not known.
  b?: (SafeSide & { cueInSec: number }) | null;
}
export interface SafePlan {
  barSec: number;
  // The outgoing track's cut: one bar after the bar line the incoming track enters on.
  outCueSec: number;
  // The bar line itself (file seconds of the outgoing track).
  entrySec: number;
  // From the incoming track's first sample to the outgoing end.
  leadSec: number;
  // The incoming cue-in (its first downbeat less the pre-roll), or null to
  // keep its own (no trusted downbeat within IN_DOWNBEAT_MAX_SEC).
  inCueSec: number | null;
  // What the bar and the bar line were measured from, for the booth line.
  source: 'grid' | 'tempo tag' | 'fallback';
}

// A tempo tag folded into 70-180 BPM: a double- or half-time tag is the same bar.
function barFromBpm(bpm: number | null | undefined): number | null {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  let b = bpm;
  while (b > 180) b /= 2;
  while (b < 70) b *= 2;
  return (60 / b) * 4;
}

export function planSafeOut(input: SafeInput): SafePlan | null {
  const a = input.a;
  if (!Number.isFinite(a.endSec) || a.endSec <= 0) return null;
  const aFloor = Math.max(0, a.cueInSec ?? 0);
  const aBpb = a.beatsPerBar && a.beatsPerBar > 0 ? a.beatsPerBar : 4;
  const aSegs = a.segments?.length && a.bpm ? trustedSegments({ segments: a.segments, beatsPerBar: aBpb, bpm: a.bpm }) : [];
  let barSec: number | null = null;
  let entrySec: number | null = null;
  let source: SafePlan['source'] = 'fallback';
  // The latest bar line of a trusted segment that leaves one bar to the end
  // and the two ride bars inside the track.
  for (const seg of [...aSegs].sort((x, y) => segStart(y) - segStart(x))) {
    const bar = periodOf(seg) * aBpb;
    const line = downbeats(seg, aBpb).reverse()
      .find((t) => t + bar <= a.endSec + 1e-6 && t - RIDE_BARS * bar >= aFloor - 1e-6);
    if (line != null) { barSec = bar; entrySec = line; source = 'grid'; break; }
  }
  if (barSec == null) {
    const tag = barFromBpm(a.bpm);
    barSec = tag ?? FALLBACK_BAR_SEC;
    source = tag ? 'tempo tag' : 'fallback';
    entrySec = a.endSec - barSec;
    if (entrySec - RIDE_BARS * barSec < aFloor) return null;
  }
  // The incoming side: its first trusted downbeat at or after its cue-in.
  let inCueSec: number | null = null;
  let preRoll = 0;
  const b = input.b;
  if (b) {
    const bBpb = b.beatsPerBar && b.beatsPerBar > 0 ? b.beatsPerBar : 4;
    const bSegs = b.segments?.length && b.bpm ? trustedSegments({ segments: b.segments, beatsPerBar: bBpb, bpm: b.bpm }) : [];
    const cue = Math.max(0, b.cueInSec);
    const first = bSegs.flatMap((seg) => downbeats(seg, bBpb))
      .filter((t) => t >= cue - 1e-6 && t - cue <= IN_DOWNBEAT_MAX_SEC)
      .sort((x, y) => x - y)[0];
    if (first != null) {
      inCueSec = Math.max(cue, first - PRE_ROLL_SEC);
      preRoll = first - inCueSec;
    }
  }
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    barSec: r(barSec),
    entrySec: r(entrySec!),
    outCueSec: r(entrySec! + barSec),
    leadSec: r(barSec + preRoll),
    inCueSec: inCueSec == null ? null : r(inCueSec),
    source,
  };
}

// What the outgoing queue item carries, matched to its successor by id.
export interface SafeOutStamps { id: string; barSec: number; leadSec: number; outCueSec: number }

// The buffer the outgoing track asks for: the ride, then the lead.
export function safeCrossSec(plan: Pick<SafePlan, 'barSec' | 'leadSec'>): number {
  return Math.round((RIDE_BARS * plan.barSec + plan.leadSec) * 1e4) / 1e4;
}
