// DJ Hot Mix (a per-show switch, show.hotMix): a show mixed like a DJ set, so
// consecutive tracks must sit close in tempo. This module owns every decision
// the switch makes; the pick paths, the request route and the show editor only
// ask it.
//
// The step limit. A pick may move at most `maxStepPct` away from the tempo of
// the track it follows, octave-safe: 64 BPM reads as 128, so a half-time
// breakdown track is not "far" from a 128 groove. The default (±3 %) is the gap
// a DJ closes by syncing the incoming track alone, leaving the outgoing one
// untouched; past it a mix splits the difference between both, and past about
// twice it no beat mix sounds smooth (mix-design.md, the operator's rule). The
// station never stretches a whole track.
//
// The curve. A show may name its tempo over its running time as a few points
// (position in %, BPM). It never widens the step: it only says which way the
// set should move, so candidates on the curve's side of the anchor are offered
// first, the way a mood's preferred energy is (scope.collect). A set therefore
// travels along the curve one step at a time, as a DJ does, and a curve that
// asks for a jump bigger than the step is walked, not jumped.
//
// Failure directions, deliberately different per path:
//   - a candidate with no usable tempo cannot be judged, so it is OUT of a Hot
//     Mix pick (the switch promises mixable neighbours, and an unknown tempo is
//     the one thing a mix cannot plan around);
//   - an anchor with no usable tempo (show start after an unmeasured track, the
//     coast, an operator push) cannot anchor a step, so the window falls back
//     to the curve's tempo at that point, and with no curve there is no window;
//   - the agent's discovery tools are HARD (a tool with nothing in the window
//     contributes nothing), while the pool picker behind them never starves: it
//     keeps the nearest tempos, compatible key first among near-equals. Only the
//     auto.m3u coast, behind both, ignores tempo at all.
//
// Requests. A Hot Mix show closes listener requests unless the operator opens
// them (hotMix.closeRequests, on by default): an ask is a tempo jump or an
// unmixable pair by nature, and it would sit in the middle of a planned run. An
// open show still applies the step to everything the DJ picks. The operator's
// own queueing is a manual action and stays exempt, as every manual trigger is.

import { keyCompat } from './mix.js';
import { repairHotMix, type HotMixCurvePoint } from '../schemas/show.js';

// Within this distance of the curve the set is where it should be: both sides of
// the anchor are equally welcome.
const CURVE_DEADBAND_PCT = 1.5;
// Among the nearest tempos, gaps this close count as equal and the key decides.
const NEAREST_TIE_PCT = 1;
// How many of the nearest tempos the never-starve fallback hands on.
const NEAREST_KEEP = 8;

// `phraseBars`: each seam's overlap, in bars; `phraseMix`: the seam placed on
// the measured kicks (music/phrase-mix-policy.ts), searched for when off.
export interface HotMix { maxStepPct: number; curve: HotMixCurvePoint[]; phraseBars: number; phraseMix: boolean }

type HotMixShow = { hotMix?: unknown } | null | undefined;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// The show's switch, through the load path's own repair (schemas/show.ts), so a
// saved show means the same thing here as in the editor. Malformed reads as off.
export function hotMixOf(show: HotMixShow): HotMix | null {
  const hm = repairHotMix(show?.hotMix);
  return hm.enabled ? { maxStepPct: hm.maxStepPct, curve: hm.curve, phraseBars: hm.phraseBars, phraseMix: hm.phraseMix } : null;
}

export function takesRequests(show: HotMixShow): boolean {
  const hm = repairHotMix(show?.hotMix);
  return !(hm.enabled && hm.closeRequests);
}

const usableBpm = (bpm: unknown): number | null => (finite(bpm) && bpm > 0 ? bpm : null);

// `to` moved by whole octaves to sit nearest `from`: the tempo a mix would
// actually meet. Null when either side is unusable.
export function octaveNearest(from: number | null, to: number | null): number | null {
  const a = usableBpm(from);
  const b = usableBpm(to);
  if (a == null || b == null) return null;
  let best = b;
  for (const c of [b / 4, b / 2, b * 2, b * 4]) {
    if (Math.abs(c - a) < Math.abs(best - a)) best = c;
  }
  return best;
}

// The octave-safe gap between two tempos, in % of `from`.
export function tempoStepPct(from: number | null, to: number | null): number | null {
  const near = octaveNearest(from, to);
  return near == null ? null : (Math.abs(near - (from as number)) / (from as number)) * 100;
}

// The curve's tempo at `position` (0..1 of the show's running time): linear
// between points, flat before the first and after the last. Null with no curve
// or no position.
export function curveBpmAt(curve: readonly HotMixCurvePoint[], position: number | null): number | null {
  if (!curve.length || position == null || !Number.isFinite(position)) return null;
  const at = Math.min(100, Math.max(0, position * 100));
  if (at <= curve[0].at) return curve[0].bpm;
  const last = curve[curve.length - 1];
  if (at >= last.at) return last.bpm;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (at <= b.at) return b.at === a.at ? b.bpm : a.bpm + ((b.bpm - a.bpm) * (at - a.at)) / (b.at - a.at);
  }
  return last.bpm;
}

export type TempoDirection = 'up' | 'down' | null;

// What one pick may choose from. `toward` is the curve's side of the anchor,
// null when the set is on the curve or there is none.
export interface TempoWindow {
  anchorBpm: number;
  maxStepPct: number;
  targetBpm: number | null;
  toward: TempoDirection;
}

export function tempoWindowFor(
  show: HotMixShow,
  anchorBpm: number | null | undefined,
  position: number | null,
): TempoWindow | null {
  const hm = hotMixOf(show);
  if (!hm) return null;
  const target = curveBpmAt(hm.curve, position);
  const anchor = usableBpm(anchorBpm) ?? target;
  if (anchor == null) return null;
  let toward: TempoDirection = null;
  const near = octaveNearest(anchor, target);
  if (near != null && (Math.abs(near - anchor) / anchor) * 100 > CURVE_DEADBAND_PCT) toward = near > anchor ? 'up' : 'down';
  return { anchorBpm: anchor, maxStepPct: hm.maxStepPct, targetBpm: target, toward };
}

export function fitsTempoWindow(bpm: number | null | undefined, w: TempoWindow): boolean {
  const step = tempoStepPct(w.anchorBpm, usableBpm(bpm));
  return step != null && step <= w.maxStepPct + 1e-9;
}

function onCurveSide(bpm: number | null | undefined, w: TempoWindow): boolean {
  if (!w.toward) return true;
  const near = octaveNearest(w.anchorBpm, usableBpm(bpm));
  if (near == null) return false;
  return w.toward === 'up' ? near >= w.anchorBpm : near <= w.anchorBpm;
}

// HARD: only tracks inside the window, the curve's side first, each side in the
// order it came. Always a fresh array.
export function withinTempoWindow<T>(tracks: readonly T[], w: TempoWindow, bpmOf: (t: T) => number | null): T[] {
  const inside = tracks.filter((t) => fitsTempoWindow(bpmOf(t), w));
  if (!w.toward) return inside;
  return [...inside.filter((t) => onCurveSide(bpmOf(t), w)), ...inside.filter((t) => !onCurveSide(bpmOf(t), w))];
}

// Never-starve, for the pool picker: the window's tracks when it has any, else
// the nearest tempos (within one step of the nearest there is, at most eight),
// compatible key first among near-equal gaps. Tracks with no
// tempo stay out unless nothing else exists. Always a fresh array.
export function nearestTempoFallback<T>(
  tracks: readonly T[],
  w: TempoWindow,
  analysisOf: (t: T) => { bpm: number | null; key: string | null },
  anchorKey: string | null,
): { tracks: T[]; relaxed: boolean } {
  const inside = withinTempoWindow(tracks, w, (t) => analysisOf(t).bpm);
  if (inside.length) return { tracks: inside, relaxed: false };
  const measured = tracks
    .map((t, i) => ({ t, i, step: tempoStepPct(w.anchorBpm, analysisOf(t).bpm), key: keyCompat(anchorKey, analysisOf(t).key) }))
    .filter((x) => x.step != null) as { t: T; i: number; step: number; key: number }[];
  if (!measured.length) return { tracks: tracks.slice(), relaxed: true };
  measured.sort((a, b) => {
    if (Math.abs(a.step - b.step) > NEAREST_TIE_PCT) return a.step - b.step;
    if (a.key !== b.key) return b.key - a.key;
    return a.i - b.i;
  });
  // The window moves out only as far as the nearest tempo there is, plus one
  // step: "the nearest tempos", not the nearest eight whatever their distance.
  const reach = measured[0].step + w.maxStepPct;
  return { tracks: measured.filter((x) => x.step <= reach + 1e-9).slice(0, NEAREST_KEEP).map((x) => x.t), relaxed: true };
}

// A short booth-log description of a window.
export function describeTempoWindow(w: TempoWindow): string {
  const lo = Math.round(w.anchorBpm * (1 - w.maxStepPct / 100));
  const hi = Math.round(w.anchorBpm * (1 + w.maxStepPct / 100));
  const curve = w.targetBpm != null ? `, curve ${Math.round(w.targetBpm)} BPM${w.toward ? ` (${w.toward})` : ''}` : '';
  return `${lo}-${hi} BPM around ${Math.round(w.anchorBpm)} (±${w.maxStepPct}%${curve})`;
}
