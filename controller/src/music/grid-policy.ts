// When the whole-track beat grid replaces the head analysis's tempo and bar
// lines (the gate was set on a 300-track dry run, `npm run grid-report`). One
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

import type { GridSegment, TrackGrid } from './library-db/grid.js';

export const STEADY_TEMPO_BAND = 0.04;
export const GRID_WRITE_GATE = {
  minCoverage: 0.8,       // detected beats on the grid
  minSteadyShare: 0.6,    // the track's share on the main tempo (any segment)
  minDownbeatAgreement: 0.75,
  maxBpm: 200,
} as const;

// The head analysis reads the first ANALYZE_SECONDS (40 s by default): with no
// stored beat to bound it, the grid's beats and bars are written over that.
export const DEFAULT_HEAD_WINDOW_MS = 40_000;

type GridShape = Pick<TrackGrid, 'status' | 'bpm' | 'segments' | 'decodedMs' | 'coverage' | 'downbeatAgreement' | 'beatsPerBar'>;

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
  const bars = bpm && (g.downbeatAgreement ?? 0) >= GRID_WRITE_GATE.minDownbeatAgreement && !!g.beatsPerBar &&
    g.segments.some((s) => s.downbeatMs != null);
  if (bpm && !bars) held.push(`bars: downbeat agreement ${r2(g.downbeatAgreement)}`);
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
