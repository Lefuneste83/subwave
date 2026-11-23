// DJ Hot Mix (a per-show switch, show.hotMix): a show mixed like a DJ set, so
// consecutive tracks must sit close in tempo. This module owns every decision
// the switch makes; the pick paths, the request route and the show editor only
// ask it.
//
// The tempo a mix can trust (`mixTempoOf`). The stored `tracks.bpm` of a track
// whose whole-track grid was not applied is the analyzer's quick estimate over
// the first 40 s, quantised to the tempogram's lags (99.4, 103.4, 107.7, 112.3,
// 117.5, 123.0, ... about 5 % apart around 120): a 3 % step cannot be judged on
// it, and a track it reads wrongly (a 125 BPM groove stored as 99.4) passes or
// fails the step on a number that is not its tempo. So a Hot Mix judgement asks
// the beat grid (library-db/grid.ts) one question: was it written over the
// stored values (applied)? If so the tempo is `tracks.bpm`, which is the grid's
// own; anything else is unknown, and the track is out of a Hot Mix pick like
// any unmeasured track. Hot Mix thus reads the one decision grid-policy.ts
// gridDecision makes, and adds none of its own: a grid passing it is applied
// after every grid answer (and `npm run grid-apply` covers older rows), a grid
// that refines the head's tempo included.
//
// What stays unknown, and why. A steady grid held by its coverage disagrees
// with the head metrically (stored against grid at about double, half, 3/2,
// 3/4 or some other ratio), and one of the two is wrong. An earlier resolver
// trusted the grid there; the operator then blind-tested a random sample of
// these tracks against a click at each tempo, and the grid was right about four
// times in five, the stored tempo the rest (one of them a 99.4 stored against a
// 125 grid, squarely in a house set's range). Four in five is not good enough
// for a 3 % step: a wrong tempo puts a beat mix on a wrong grid, which is worse
// than leaving the track out. A grid the operator reverted (applied -1) is
// unknown too: the operator said it is wrong. A grid without the write (no grid,
// unsteady, failed, double time) is unknown as before. Nothing stored is
// rewritten, and no other reader (a show without Hot Mix, the effects, the
// tagging words) sees this: it is the Hot Mix view only.
//
// The step limit. A pick may sit at most `maxStepPct` away from its anchor,
// octave-safe: 64 BPM reads as 128, so a half-time breakdown track is not
// "far" from a 128 groove. The default (±3 %) is the gap a DJ closes by syncing
// the incoming track alone, leaving the outgoing one untouched; past it a mix
// splits the difference between both, and past about twice it no beat mix
// sounds smooth (mix-design.md, the operator's rule). The station never
// stretches a whole track.
//
// The anchor. A show with a curve (a few points of position in %, BPM over its
// running time) anchors every pick on the curve's tempo at the pick's forecast
// air position (`targetBpmAt`), never on the track before it: a DJ picks close
// to the target and keeps the set there. Anchoring on the predecessor let the
// set drift: each pick sits up to a step from the last one, so a show that
// opens after a 96 BPM track crawls toward its 122 curve a step at a time, and
// a pick pulled to the target during a seam and back to its own tempo after it
// takes the next window further away. Two consecutive picks can then differ by
// up to twice the step, which the seam planner (hot-mix-seam.ts) mixes by
// meeting halfway, and past that takes the safe transition. Inside the window
// the tempos nearest the target are offered first. A show without a curve has
// no target, so its anchor stays the predecessor's tempo (through the same
// resolver), and the set wanders freely within the step.
//
// Failure directions, deliberately different per path:
//   - a candidate with no usable tempo cannot be judged, so it is OUT of a Hot
//     Mix pick (the switch promises mixable neighbours, and an unknown tempo is
//     the one thing a mix cannot plan around);
//   - without a curve, an anchor with no usable tempo (show start after an
//     unmeasured track, the coast, an operator push) cannot anchor a step, so
//     there is no window; a curve whose position is unknown stands aside the
//     same way, anchoring on the predecessor;
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

import { keyCompat, type Analysis } from './mix.js';
import type { GridApplied, GridStatus } from './library-db/grid.js';
import { repairHotMix, type HotMixCurvePoint } from '../schemas/show.js';

// Within this distance of the curve's tempo a candidate is on target: offered
// ahead of the rest of the window.
const ON_TARGET_PCT = 1.5;
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

// What the resolver reads of one track: its stored tempo and its grid row's
// state (null when the track has none). Read by library.mixTempoFor.
export interface MixTempoFacts {
  bpm: number | null;
  grid: { status: GridStatus; applied: GridApplied } | null;
}

// The tempo a Hot Mix judgement may use (header): the applied grid's, which is
// the stored tempo, or null for unknown.
export function mixTempoOf(f: MixTempoFacts | null | undefined): number | null {
  const g = f?.grid;
  return g && g.status === 'ok' && g.applied === 1 ? usableBpm(f!.bpm) : null;
}

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

// The show's target tempo at `position` (0..1 of its running time): the
// curve's, or null for a show without Hot Mix, without a curve, or at an
// unknown position. The one answer to "what tempo should the set be at now".
export function targetBpmAt(show: HotMixShow, position: number | null): number | null {
  const hm = hotMixOf(show);
  return hm ? curveBpmAt(hm.curve, position) : null;
}

// What one pick may choose from: the step around `anchorBpm`, which is the
// curve's tempo when `anchoredOn` is 'curve' (then also `targetBpm`) and the
// predecessor's otherwise.
export interface TempoWindow {
  anchorBpm: number;
  maxStepPct: number;
  targetBpm: number | null;
  anchoredOn: 'curve' | 'predecessor';
}

// `predecessorBpm` is the track this pick follows, through mixTempoOf: read
// only when the curve gives no target.
export function tempoWindowFor(
  show: HotMixShow,
  predecessorBpm: number | null | undefined,
  position: number | null,
): TempoWindow | null {
  const hm = hotMixOf(show);
  if (!hm) return null;
  const target = usableBpm(curveBpmAt(hm.curve, position));
  if (target != null) return { anchorBpm: target, maxStepPct: hm.maxStepPct, targetBpm: target, anchoredOn: 'curve' };
  const anchor = usableBpm(predecessorBpm);
  if (anchor == null) return null;
  return { anchorBpm: anchor, maxStepPct: hm.maxStepPct, targetBpm: null, anchoredOn: 'predecessor' };
}

export function fitsTempoWindow(bpm: number | null | undefined, w: TempoWindow): boolean {
  const step = tempoStepPct(w.anchorBpm, usableBpm(bpm));
  return step != null && step <= w.maxStepPct + 1e-9;
}

function onTarget(bpm: number | null | undefined, w: TempoWindow): boolean {
  if (w.targetBpm == null) return true;
  const step = tempoStepPct(w.targetBpm, usableBpm(bpm));
  return step != null && step <= ON_TARGET_PCT + 1e-9;
}

// HARD: only tracks inside the window, those on the curve's target first, each
// group in the order it came (a source's own shuffle survives). Always a fresh
// array.
export function withinTempoWindow<T>(tracks: readonly T[], w: TempoWindow, bpmOf: (t: T) => number | null): T[] {
  const inside = tracks.filter((t) => fitsTempoWindow(bpmOf(t), w));
  if (w.targetBpm == null) return inside;
  return [...inside.filter((t) => onTarget(bpmOf(t), w)), ...inside.filter((t) => !onTarget(bpmOf(t), w))];
}

// Never-starve, for the pool picker: the window's tracks when it has any, else
// the tempos nearest its anchor (the curve's target, or the predecessor), within
// one step of the nearest there is, at most eight, compatible key first among
// near-equal gaps. Tracks with no tempo stay out unless nothing else exists.
// Always a fresh array.
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

// What a pick's soft ranking (the pool's re-rank, the Shortlist's order) aims
// at in a Hot Mix pick: the window's anchor tempo (the curve's, with one) and
// the predecessor's key, so the nearest tempo to the target comes first and
// the key breaks near-ties. Outside Hot Mix, the predecessor's analysis as is.
export function hotMixRankTarget(w: TempoWindow | null, predecessor: Analysis | null): Analysis | null {
  if (!w) return predecessor;
  return { ...(predecessor ?? { key: null }), bpm: w.anchorBpm };
}

// Whether a tempo can ever fit a window of this curve: inside the step around
// the curve's lowest-to-highest tempo, octave-safe. The show editor's count.
export function withinCurveReach(bpm: number | null | undefined, hm: HotMix): boolean {
  if (!hm.curve.length) return false;
  const lo = Math.min(...hm.curve.map((p) => p.bpm));
  const hi = Math.max(...hm.curve.map((p) => p.bpm));
  const near = octaveNearest((lo + hi) / 2, usableBpm(bpm));
  return near != null && near >= lo * (1 - hm.maxStepPct / 100) - 1e-9 && near <= hi * (1 + hm.maxStepPct / 100) + 1e-9;
}

// A short booth-log description of a window.
export function describeTempoWindow(w: TempoWindow): string {
  const lo = Math.round(w.anchorBpm * (1 - w.maxStepPct / 100));
  const hi = Math.round(w.anchorBpm * (1 + w.maxStepPct / 100));
  const on = w.anchoredOn === 'curve' ? "the curve's tempo" : "the previous track's tempo";
  return `${lo}-${hi} BPM around ${Math.round(w.anchorBpm)} (±${w.maxStepPct}%, ${on})`;
}
