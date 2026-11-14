// The beat grid's dry-run report: what replacing today's BPM and
// bar lines with the whole-track grid WOULD change, track by track. Read-only:
// it reads tracks + track_grid and writes nothing to the library. The operator
// approves this report before any grid value reaches `bpm`/`bars_json` (step 4).
//
// A corrected BPM ripples (the operator's 11 Nov rule): track order (mix.ts
// bpmCompat), tempo-synced effects, stem-blend bars, picker filters, and the
// Sound: line's tempo word, whose change re-embeds the track's text vector.
// So per track it reports:
//   - stored BPM → grid BPM, and the relation between them: the same tempo,
//     an octave (double / half), a 3:2 family error, or another tempo;
//   - whether the Sound: line's measured words move (soundWords, the same
//     function the embed text uses): every such track re-embeds;
//   - where today's first stored bar line sits on the grid: on a downbeat, or
//     how many beats off (a bar shift moves every bar-snapped transition);
//   - the grid's own confidence (beats on the grid, the share of the track on
//     the main tempo, downbeat agreement), and the write step 4 would make under
//     its proposed gate (GRID_WRITE_GATE), so the operator approves a rule, not
//     a list.
// Pure except for the CLI at the bottom (grid-report-cli.ts).

import { soundWords, trackAcoustics, type AcousticsFields } from './sound-line.js';
import type { GridSegment, TrackGrid } from './library-db/grid.js';
import { gridDecision } from './grid-policy.js';

export type TempoRelation = 'same' | 'double' | 'half' | 'three-halves' | 'two-thirds' | 'other' | 'no-stored-bpm';

// Ratio grid/stored within this relative tolerance of a simple ratio.
const RELATIONS: Array<[TempoRelation, number]> = [
  ['same', 1], ['double', 2], ['half', 0.5], ['three-halves', 1.5], ['two-thirds', 2 / 3],
];
// librosa's tempo estimates fall on a coarse grid (112.35, 117.45, 123.05,
// 129.2…), about 4.5 % apart: a true tempo can read up to half a step off.
export const SAME_TEMPO_TOLERANCE = 0.03;

export function tempoRelation(stored: number | null | undefined, grid: number): TempoRelation {
  if (stored == null || !Number.isFinite(stored) || stored <= 0) return 'no-stored-bpm';
  const r = grid / stored;
  for (const [name, target] of RELATIONS) {
    if (Math.abs(r / target - 1) <= SAME_TEMPO_TOLERANCE) return name;
  }
  return 'other';
}

// The gate is music/grid-policy.ts, the one the write uses: re-exported so
// the report's readers keep one import.
export { GRID_WRITE_GATE, STEADY_TEMPO_BAND, steadyShare } from './grid-policy.js';

// A beat time of the grid nearest `ms`, within the segment that covers it.
function segmentAt(segments: GridSegment[], ms: number): GridSegment | null {
  for (const s of segments) {
    const end = s.anchorMs + ((s.beats - 1) * s.periodUs) / 1000;
    if (ms >= s.anchorMs - s.periodUs / 2000 && ms <= end + s.periodUs / 2000) return s;
  }
  return null;
}

// Where a stored bar line sits on the grid, in beats from the nearest downbeat
// (0 = on a downbeat; ±1, ±2… = that many beats off; fractional = off the
// beat). Null when the grid has no downbeat phase there or the time is outside
// every segment.
export function barOffsetBeats(grid: Pick<TrackGrid, 'segments' | 'beatsPerBar'>, barMs: number): number | null {
  const s = segmentAt(grid.segments, barMs);
  if (!s || s.downbeatMs == null || !grid.beatsPerBar) return null;
  const period = s.periodUs / 1000;
  const bar = period * grid.beatsPerBar;
  const k = Math.round((barMs - s.downbeatMs) / bar);
  const offsetBeats = (barMs - (s.downbeatMs + k * bar)) / period;
  return Math.round(offsetBeats * 100) / 100;
}

// The share of stored beats within `tolMs` of a grid beat (today's 40 s head
// grid read against the whole-track one).
export function storedBeatsOnGrid(segments: GridSegment[], beatsMs: readonly number[], tolMs = 70): number | null {
  if (!beatsMs.length) return null;
  let on = 0;
  for (const b of beatsMs) {
    const s = segmentAt(segments, b);
    if (!s) continue;
    const p = s.periodUs / 1000;
    const k = Math.round((b - s.anchorMs) / p);
    if (Math.abs(b - (s.anchorMs + k * p)) <= tolMs) on += 1;
  }
  return on / beatsMs.length;
}

export interface GridReportTrack extends AcousticsFields {
  id: string;
  artist: string | null;
  title: string | null;
  genres?: string[];
  beats: number[] | null;
  bars: number[] | null;
}

// The track as the head analysis left it: once a grid is applied, the
// track carries the grid's values, and the head's own are kept on the grid row.
export function withHeadValues<T extends GridReportTrack>(t: T, g: TrackGrid): T {
  if (g.applied !== 1) return t;
  const ms = (json: string | null): number[] | null => {
    if (!json) return null;
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : null;
    } catch {
      return null;
    }
  };
  return { ...t, bpm: g.headBpm, beats: ms(g.headBeatsJson), bars: ms(g.headBarsJson) };
}

export interface GridReportRow {
  id: string;
  artist: string;
  title: string;
  genre: string;
  storedBpm: number | null;
  gridBpm: number;
  deltaBpm: number | null;
  relation: TempoRelation;
  wordsBefore: string;
  wordsAfter: string;
  reEmbed: boolean;
  barOffsetBeats: number | null;
  barShift: boolean;
  storedBeatsOnGrid: number | null;
  segments: number;
  coverage: number | null;
  mainShare: number | null;
  steadyShare: number | null;
  downbeatAgreement: number | null;
  beatsPerBar: number | null;
  // What step 4 would write under GRID_WRITE_GATE.
  wouldWriteBpm: boolean;
  wouldWriteBars: boolean;
  heldBecause: string | null;
}

const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

export function compareGrid(t: GridReportTrack, g: TrackGrid): GridReportRow | null {
  if (g.status !== 'ok' || g.bpm == null || !g.segments.length) return null;
  const before = soundWords(trackAcoustics(t)).measured;
  const after = soundWords(trackAcoustics({ ...t, bpm: g.bpm })).measured;
  const firstBar = (t.bars ?? []).find((b) => Number.isFinite(b) && b >= 0);
  const offset = firstBar != null ? barOffsetBeats(g, firstBar) : null;
  const decision = gridDecision(g);
  const confident = decision.bpm;
  const steady = decision.steadyShare;
  return {
    id: t.id,
    artist: t.artist ?? '',
    title: t.title ?? '',
    genre: t.genres?.[0] ?? '',
    storedBpm: round(t.bpm),
    gridBpm: g.bpm,
    deltaBpm: t.bpm != null ? round(g.bpm - t.bpm) : null,
    relation: tempoRelation(t.bpm, g.bpm),
    wordsBefore: before.join(', '),
    wordsAfter: after.join(', '),
    reEmbed: confident && before.join('|') !== after.join('|'),
    barOffsetBeats: offset,
    barShift: offset != null && Math.abs(offset) >= 0.25,
    storedBeatsOnGrid: round(storedBeatsOnGrid(g.segments, t.beats ?? [])),
    segments: g.segments.length,
    coverage: g.coverage,
    mainShare: g.mainShare,
    steadyShare: round(steady),
    downbeatAgreement: g.downbeatAgreement,
    beatsPerBar: g.beatsPerBar,
    wouldWriteBpm: confident,
    wouldWriteBars: decision.bars,
    heldBecause: decision.held.length ? decision.held.join('; ') : null,
  };
}

export interface GridReportSummary {
  tracks: number;
  byRelation: Record<TempoRelation, number>;
  bpmChangesOver1: number;      // |Δ| > 1 BPM, among those step 4 would write
  wouldWriteBpm: number;
  wouldWriteBars: number;
  reEmbeds: number;
  barShifts: number;            // among those step 4 would write bars for
  held: number;
  medianAbsDelta: number | null; // same-tempo tracks: the quantisation fixed
}

export function summariseGridReport(rows: readonly GridReportRow[]): GridReportSummary {
  const byRelation = { same: 0, double: 0, half: 0, 'three-halves': 0, 'two-thirds': 0, other: 0, 'no-stored-bpm': 0 } as Record<TempoRelation, number>;
  for (const r of rows) byRelation[r.relation] += 1;
  const same = rows.filter((r) => r.relation === 'same' && r.deltaBpm != null).map((r) => Math.abs(r.deltaBpm!)).sort((a, b) => a - b);
  return {
    tracks: rows.length,
    byRelation,
    bpmChangesOver1: rows.filter((r) => r.wouldWriteBpm && (r.deltaBpm == null || Math.abs(r.deltaBpm) > 1)).length,
    wouldWriteBpm: rows.filter((r) => r.wouldWriteBpm).length,
    wouldWriteBars: rows.filter((r) => r.wouldWriteBars).length,
    reEmbeds: rows.filter((r) => r.reEmbed).length,
    barShifts: rows.filter((r) => r.wouldWriteBars && r.barShift).length,
    held: rows.filter((r) => !r.wouldWriteBpm).length,
    medianAbsDelta: same.length ? same[Math.floor(same.length / 2)] : null,
  };
}

const CSV_COLUMNS: Array<keyof GridReportRow> = [
  'id', 'artist', 'title', 'genre', 'storedBpm', 'gridBpm', 'deltaBpm', 'relation', 'wordsBefore', 'wordsAfter',
  'reEmbed', 'barOffsetBeats', 'barShift', 'storedBeatsOnGrid', 'segments', 'coverage', 'mainShare', 'steadyShare',
  'downbeatAgreement', 'beatsPerBar', 'wouldWriteBpm', 'wouldWriteBars', 'heldBecause',
];

export function gridReportCsv(rows: readonly GridReportRow[]): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
