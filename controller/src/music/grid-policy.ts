// When the whole-track beat grid replaces the head analysis's tempo and bar
// lines (F17; the operator approved this gate on a 300-track dry run). One
// decision for every caller: the write (library-db/tracks.ts
// applyGridToTrack) and the dry-run report (music/grid-report.ts). Pure.
//
// A grid replaces the stored BPM only when the model held it with confidence:
//   - most detected beats sit on the fitted grid (coverage);
//   - the main tempo covers most of the track, counted over every segment
//     within STEADY_TEMPO_BAND of it (a live drummer or a break splits a steady
//     song into segments that all agree; the main segment alone held 27 such
//     songs out of 300);
//   - at most maxBpm: the only confident grids above it were double-time
//     readings (220 and 226 for songs near 110). Octave-safe: a grid above it
//     is held, the stored value kept, never halved to fit.
// Bar lines also need the downbeats to agree on one phase (one real track
// read 0.56: its bar line split across two phases). With the BPM written and
// the bars held, beats and bars both stay the head's own, so they never
// disagree with each other.
//
// Or, the half-bar case. Beat This! often cannot tell beat 1 from beat 3 in
// the body of a 4/4 track: its downbeats land on phase p and p+2 alternately,
// the single-phase agreement falls under the gate, and the track lost its bars
// (no structure facet, no phrase mix) although its tempo grid is excellent.
// The bars are also trusted when, on the main segment, nearly every downbeat
// sits on that half-bar pair (`downbeatHalfbar`, the share on the dominant
// phase and the one two beats away, 4/4 only, >= minHalfbar). Which half is
// the bar line is the worker's call, made before the grid is stored
// (analyze_worker.py place_half_bar): the model's majority phase, unless the
// beat where the track's biggest low-end change lands (the drop) sits one or
// two beats after it, which puts the bar line on the other half
// (`downbeatPhase` 'drop' / 'majority', `downbeatDropDb` the drop's jump).
// Checked by blind listening tests on half-bar tracks: the majority was right
// on 20 of 24, the drop rule matched 23 of 24 of the operator's verdicts, and
// 14 of 15 on a fresh set when the drop is clear. The misses gathered on weak
// drops, and a wrong bar line is worse than none (a phrase-mix seam two beats
// off, where a plain beat mix was fine), so only a half-bar grid whose bar
// line the drop placed (`downbeatPhase` 'drop', `downbeatDropDb` >=
// minDropDb) is trusted; one left on the majority keeps its bars held. minHalfbar,
// minDropDb and
// minDownbeatAgreement are mirrored by analyze_worker.py's GRID_MIN_HALFBAR,
// GRID_DROP_MIN_DB and GRID_MIN_DOWNBEAT_AGREEMENT (the worker only looks for the half in the
// band this rule rescues); the decision is made here. A grid measured before
// the worker reported the share (null) decides exactly as before.

import type { GridSegment, TrackGrid } from './library-db/grid.js';

export const STEADY_TEMPO_BAND = 0.04;
export const GRID_WRITE_GATE = {
  minCoverage: 0.8,       // detected beats on the grid
  minSteadyShare: 0.6,    // the track's share on the main tempo (any segment)
  minDownbeatAgreement: 0.75,
  // The half-bar case (header).
  minHalfbar: 0.9,        // downbeats on the dominant phase or two beats away
  minDropDb: 15,          // the drop that placed a half-bar grid's bar line
  maxBpm: 200,
} as const;

// The head analysis reads the first ANALYZE_SECONDS (40 s by default): with no
// stored beat to bound it, the grid's beats and bars are written over that.
export const DEFAULT_HEAD_WINDOW_MS = 40_000;

// The half-bar case's fields are optional: an absent share is null, the
// single-phase rule alone. The drop's figures ride along (the structure
// facet's grid carries them) and never change the decision.
type GridShape = Pick<TrackGrid, 'status' | 'bpm' | 'segments' | 'decodedMs' | 'coverage' | 'downbeatAgreement' | 'beatsPerBar'> &
  Partial<Pick<TrackGrid, 'downbeatHalfbar' | 'downbeatDropDb' | 'downbeatPhase'>>;

export function steadyShare(g: Pick<TrackGrid, 'bpm' | 'segments' | 'decodedMs'>): number | null {
  if (!g.bpm || !g.decodedMs || g.decodedMs <= 0) return null;
  let ms = 0;
  for (const s of g.segments) {
    const bpm = 60_000_000 / s.periodUs;
    if (Math.abs(bpm / g.bpm - 1) <= STEADY_TEMPO_BAND) ms += ((s.beats - 1) * s.periodUs) / 1000;
  }
  return Math.min(1, ms / g.decodedMs);
}

export interface GridDecision {
  bpm: boolean;
  bars: boolean;
  steadyShare: number | null;
  held: string[];
}

const r2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));

// The half-bar case (header): the share at its threshold, and the bar line
// placed by a clear drop.
export function halfbarTrusted(g: Pick<GridShape, 'downbeatHalfbar' | 'downbeatPhase' | 'downbeatDropDb'>): boolean {
  const half = g.downbeatHalfbar;
  const drop = g.downbeatDropDb;
  return half != null && Number.isFinite(half) && half >= GRID_WRITE_GATE.minHalfbar &&
    g.downbeatPhase === 'drop' && drop != null && Number.isFinite(drop) && drop >= GRID_WRITE_GATE.minDropDb;
}

export function gridDecision(g: GridShape | null | undefined): GridDecision {
  if (!g || g.status !== 'ok' || g.bpm == null || !g.segments.length) {
    return { bpm: false, bars: false, steadyShare: null, held: ['no measured grid'] };
  }
  const steady = steadyShare(g);
  const held: string[] = [];
  if ((g.coverage ?? 0) < GRID_WRITE_GATE.minCoverage) held.push(`coverage ${r2(g.coverage)}`);
  if ((steady ?? 0) < GRID_WRITE_GATE.minSteadyShare) held.push(`steady tempo on ${r2(steady)} of the track`);
  if (g.bpm > GRID_WRITE_GATE.maxBpm) held.push(`${g.bpm} BPM, above ${GRID_WRITE_GATE.maxBpm}: possibly double time`);
  const bpm = held.length === 0;
  const phased = !!g.beatsPerBar && g.segments.some((s) => s.downbeatMs != null);
  const bars = bpm && phased &&
    ((g.downbeatAgreement ?? 0) >= GRID_WRITE_GATE.minDownbeatAgreement || halfbarTrusted(g));
  if (bpm && !bars) {
    // The share appears only once the worker reported it: a grid measured
    // before keeps its old message.
    held.push(`bars: downbeat agreement ${r2(g.downbeatAgreement)}` +
      (g.downbeatHalfbar != null
        ? `, half-bar ${f2(g.downbeatHalfbar)}, ${g.downbeatPhase === 'drop' ? `drop ${g.downbeatDropDb} dB` : 'no clear drop'}`
        : ''));
  }
  return { bpm, bars, steadyShare: steady, held };
}

// The head window the stored beats and bars cover: up to the last of them,
// or the default head window when none is stored.
export function headWindowEndMs(beats: readonly number[] | null, bars: readonly number[] | null): number {
  const last = Math.max(-1, ...(beats ?? []), ...(bars ?? []));
  return last >= 0 ? last : DEFAULT_HEAD_WINDOW_MS;
}

const segmentEnd = (s: GridSegment) => s.anchorMs + ((s.beats - 1) * s.periodUs) / 1000;

function uniqueSorted(ms: number[]): number[] {
  const out: number[] = [];
  for (const v of ms.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] >= 1) out.push(v);
  return out;
}

// The grid's beats in [fromMs, endMs], ms.
export function gridBeatsWithin(segments: readonly GridSegment[], endMs: number, fromMs = 0): number[] {
  const out: number[] = [];
  for (const s of segments) {
    const p = s.periodUs / 1000;
    for (let k = 0; k < s.beats; k++) {
      const t = s.anchorMs + k * p;
      if (t > endMs) break;
      if (t >= fromMs && t >= 0) out.push(Math.round(t));
    }
  }
  return uniqueSorted(out);
}

// The grid's bar lines in [0, endMs], ms: each segment's downbeat phase, one
// line every beatsPerBar beats across the segment. A segment with no settled
// phase gives none.
export function gridBarsWithin(segments: readonly GridSegment[], beatsPerBar: number, endMs: number, fromMs = 0): number[] {
  const out: number[] = [];
  for (const s of segments) {
    if (s.downbeatMs == null) continue;
    const bar = (s.periodUs / 1000) * beatsPerBar;
    const from = s.anchorMs - s.periodUs / 2000;
    const to = Math.min(segmentEnd(s) + s.periodUs / 2000, endMs);
    const j0 = Math.ceil((from - s.downbeatMs) / bar);
    for (let j = j0; ; j++) {
      const t = s.downbeatMs + j * bar;
      if (t > to) break;
      if (t >= fromMs && t >= 0) out.push(Math.round(t));
    }
  }
  return uniqueSorted(out);
}

// The tempo of the grid segment that covers most of [fromMs, toMs] (an outro
// that slows down keeps its own tempo), 2 decimals; null when no segment
// covers at least MIN_WINDOW_BEATS of it.
const MIN_WINDOW_BEATS = 4;
export function gridTempoWithin(segments: readonly GridSegment[], fromMs: number, toMs: number): number | null {
  let best: GridSegment | null = null;
  let bestMs = 0;
  for (const s of segments) {
    const overlap = Math.min(segmentEnd(s), toMs) - Math.max(s.anchorMs, fromMs);
    if (overlap > bestMs) { best = s; bestMs = overlap; }
  }
  if (!best || bestMs < (MIN_WINDOW_BEATS * best.periodUs) / 1000) return null;
  return Math.round((60_000_000 / best.periodUs) * 100) / 100;
}
