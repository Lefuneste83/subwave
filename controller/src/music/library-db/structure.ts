// The per-bar musical structure (the analyzer's opt-in `structure` facet): its
// own table, one row per track, holding the measured bars and the facet's
// whole state (status, reason, attempts, and which grid it was measured on).
//
// What it is for: the operator's DJ transition recipe. The outgoing track
// leaves after its last hard kick + N bars, the incoming one enters N bars
// before its first hard kick, its bass punched in on that kick. The points are
// rules over these arrays (music/structure-policy.ts), not stored: a rule
// change re-reads nothing. Only a Hot Mix show's opt-in phrase mix reads them
// (music/phrase-mix-policy.ts), so the facet alone changes nothing on air.
//
// Per bar of the track's own beat grid (library-db/grid.ts) the analyzer
// measures (analyze_worker.facet_structure), levels in dB against the track's
// loud bars (90th percentile) and stored as the 0.5 dB step at or below the
// measurement (floored, so a threshold test on the step is exact):
//   kick    the < 100 Hz envelope peak at the bar's beats (median of them);
//   kicks   how many of its beats carry a < 150 Hz hit;
//   bass    40-120 Hz between the kicks; mid 250 Hz-4 kHz; high > 4 kHz;
//   level   the whole band (a bar under structure-policy SILENT_DB is silent);
//   melody  how tonal the 250 Hz-4 kHz band is: the bar's mean of
//           -10*log10(spectral flatness) of its magnitude spectrum (4096-sample
//           frames). 0 dB = noise-like, higher = clearer pitched lines. An
//           absolute figure, not against the loud bars.
// and `runs` ([startMs, barUs, count]: `count` equal bars from startMs) map the
// bars to seconds. Arrays, never an object per bar: a few KB a track.
//
// Why a table of its own and its own attempts: the same reasons as the grid's
// (grid.ts): opt-in (`npm run analyze -- --facets structure`), so an upgrade
// changes nothing; its failures must never touch the track's shared analysis
// failure count, nor the other way round; rolling back is dropping the table.
//
// It needs bars it can trust: a grid that passes grid-policy.ts gridDecision
// with its bars. Its facet row is derived (deriveStructureRow):
//   - no grid row: no structure row, and the track is not due (the planner
//     skips it as `no-grid`);
//   - a grid without trusted bars: `unmeasurable / no-bars`, settled, never
//     sent to the analyzer, due again once a re-measured grid gains its bars;
//   - a stored row measured on another grid than the current one (`grid_at` is
//     the track_grid.measured_at it was measured on): one version below,
//     `grid-changed`, due again;
//   - otherwise the stored row as is.
//
// The row follows the track like the grid's: a replaced file drops it
// (tracks.clearTrackAudio), an ID rotation moves it (the new id's own row
// wins, id-adoption.ts), a pruned track takes it along.

import type Database from 'better-sqlite3';
import { requireDb } from './handle.js';
import { parseSegments, phaseSourceOrNull, type GridSegment } from './grid.js';
import { gridDecision } from '../grid-policy.js';

// The analyzer's structure answer version (analyze_worker.STRUCTURE_VERSION).
export const STRUCTURE_FACET_VERSION = 1;

export type StructureStatus = 'ok' | 'unmeasurable' | 'failed';

// [startMs, barUs, count]: `count` bars of barUs microseconds from startMs.
export type StructureRun = [number, number, number];

export interface StructureBars {
  runs: StructureRun[];
  kick: number[];
  kicks: number[];
  bass: number[];
  mid: number[];
  high: number[];
  level: number[];
  melody: number[];
}

export const STRUCTURE_BAR_ARRAYS = ['kick', 'kicks', 'bass', 'mid', 'high', 'level', 'melody'] as const;

// The analyzer's `structure` data, as parsed by parseStructureBars.
export interface StructureAnswer {
  version: number;
  bars: StructureBars;
  decodedMs: number | null;
}

export interface TrackStructure {
  status: StructureStatus;
  version: number;
  reason: string | null;
  attempts: number;
  measuredAt: string;
  // The track_grid.measured_at the bars were measured on.
  gridAt: string | null;
  bars: StructureBars | null;
}

// The most beats a bar can hold (grid.ts beatsPerBar is 2..7).
const MAX_BEATS_PER_BAR = 7;
// dB figures outside this are a malformed answer (levels are clamped by the
// worker at -99 dB, melody is at most ~60 dB).
const DB_BOUND = 200;

// THE parser of the arrays, for the analyzer's answer and the stored JSON
// alike. Strict: every array one length, the runs adding up to it, finite
// numbers, at least one bar; anything else is null (a failed attempt, never a
// partial row).
export function parseStructureBars(data: unknown): StructureBars | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.runs) || d.runs.length === 0) return null;
  const runs: StructureRun[] = [];
  let total = 0;
  for (const r of d.runs as unknown[]) {
    if (!Array.isArray(r) || r.length !== 3 || !r.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const [start, barUs, count] = r as number[];
    if (barUs <= 0 || count < 1 || !Number.isInteger(count) || start < 0) return null;
    runs.push([Math.round(start), Math.round(barUs), count]);
    total += count;
  }
  const out: Partial<StructureBars> = { runs };
  for (const k of STRUCTURE_BAR_ARRAYS) {
    const a = d[k];
    if (!Array.isArray(a) || a.length !== total) return null;
    if (!a.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= DB_BOUND)) return null;
    if (k === 'kicks' && !a.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_BEATS_PER_BAR)) return null;
    out[k] = a as number[];
  }
  return out as StructureBars;
}

// Created on every open (facets.ensureFacetStatus), before the facet table is
// derived: FACET_SOURCE_SELECT reads it. Idempotent.
export function ensureStructureTable(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS track_structure (
    track_id     TEXT    PRIMARY KEY,
    status       TEXT    NOT NULL CHECK (status IN ('ok','unmeasurable','failed')),
    version      INTEGER NOT NULL,
    reason       TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    measured_at  TEXT    NOT NULL,
    grid_at      TEXT,
    bars_json    TEXT
  ) WITHOUT ROWID`);
}

// The facet derivation's view of this table and of the grid it needs, as
// columns of a `FROM tracks` select (FACET_SOURCE_SELECT): primary-key probes.
export const STRUCTURE_SOURCE_SELECT =
  `(SELECT s.status   FROM track_structure s WHERE s.track_id = tracks.id) AS structure_status,
   (SELECT s.version  FROM track_structure s WHERE s.track_id = tracks.id) AS structure_version,
   (SELECT s.reason   FROM track_structure s WHERE s.track_id = tracks.id) AS structure_reason,
   (SELECT s.attempts FROM track_structure s WHERE s.track_id = tracks.id) AS structure_attempts,
   (SELECT s.grid_at  FROM track_structure s WHERE s.track_id = tracks.id) AS structure_grid_at,
   (SELECT json_object('status', g.status, 'bpm', g.bpm, 'beatsPerBar', g.beats_per_bar,
      'segments', g.segments_json, 'coverage', g.coverage, 'downbeatAgreement', g.downbeat_agreement,
      'downbeatHalfbar', g.downbeat_halfbar, 'downbeatDropDb', g.downbeat_drop_db, 'downbeatPhase', g.downbeat_phase,
      'decodedMs', g.decoded_ms, 'measuredAt', g.measured_at)
      FROM track_grid g WHERE g.track_id = tracks.id) AS structure_grid`;

export interface StructureSourceRow {
  structure_status?: StructureStatus | null;
  structure_version?: number | null;
  structure_reason?: string | null;
  structure_attempts?: number | null;
  structure_grid_at?: string | null;
  structure_grid?: string | null; // the grid row as JSON (STRUCTURE_SOURCE_SELECT)
}

// What the structure is measured on: a grid whose bars grid-policy.ts trusts.
export interface StructureGrid {
  gridAt: string;
  beatsPerBar: number;
  segments: GridSegment[];
  decodedMs: number | null;
}

type GridShape = Parameters<typeof gridDecision>[0] & { measuredAt?: string };

// The trusted-bars grid, or null (no grid, or bars the grid policy holds).
export function structureGridOf(g: GridShape | null | undefined): StructureGrid | null {
  if (!g || !gridDecision(g).bars || !g.beatsPerBar || !g.measuredAt) return null;
  return { gridAt: g.measuredAt, beatsPerBar: g.beatsPerBar, segments: [...g.segments], decodedMs: g.decodedMs ?? null };
}

function gridOfRow(json: string | null | undefined): { present: boolean; grid: StructureGrid | null } {
  if (!json) return { present: false, grid: null };
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      present: true,
      grid: structureGridOf({
        status: v.status as GridShape['status'], bpm: num(v.bpm), beatsPerBar: num(v.beatsPerBar),
        segments: parseSegments(typeof v.segments === 'string' ? v.segments : null), coverage: num(v.coverage),
        downbeatAgreement: num(v.downbeatAgreement), downbeatHalfbar: num(v.downbeatHalfbar),
        downbeatDropDb: num(v.downbeatDropDb), downbeatPhase: phaseSourceOrNull(v.downbeatPhase), decodedMs: num(v.decodedMs),
        measuredAt: typeof v.measuredAt === 'string' ? v.measuredAt : undefined,
      }),
    };
  } catch {
    return { present: true, grid: null };
  }
}

export interface DerivedStructureRow {
  status: StructureStatus;
  version: number;
  reason: string | null;
  attempts: number;
}

// The structure facet row of one track (see the header), or null for none.
// Pure.
export function deriveStructureRow(row: StructureSourceRow): DerivedStructureRow | null {
  const grid = gridOfRow(row.structure_grid);
  if (grid.present && !grid.grid) {
    return { status: 'unmeasurable', version: STRUCTURE_FACET_VERSION, reason: 'no-bars', attempts: 0 };
  }
  if (!row.structure_status) return null;
  const version = row.structure_version ?? STRUCTURE_FACET_VERSION;
  const attempts = row.structure_attempts ?? 0;
  if (!grid.grid || row.structure_grid_at !== grid.grid.gridAt) {
    // Measured on another grid: due again. A kept measurement carries the
    // failures since (bounded like any other); a failure on the old grid
    // says nothing about the new one.
    return {
      status: row.structure_status, version: Math.min(version, STRUCTURE_FACET_VERSION) - 1, reason: 'grid-changed',
      attempts: row.structure_status === 'ok' ? attempts : 0,
    };
  }
  return { status: row.structure_status, version, reason: row.structure_reason ?? null, attempts };
}

// A measured structure: replaces whatever was stored, attempts back to 0.
export function writeStructure(id: string, a: StructureAnswer, gridAt: string, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_structure (track_id, status, version, reason, attempts, measured_at, grid_at, bars_json)
     VALUES (?, 'ok', ?, NULL, 0, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET status = 'ok', version = excluded.version, reason = NULL, attempts = 0,
       measured_at = excluded.measured_at, grid_at = excluded.grid_at, bars_json = excluded.bars_json`,
  ).run(id, Math.round(a.version), at, gridAt, JSON.stringify(a.bars));
}

// The analyzer read the file and could not measure it (too long, no bar inside
// the audio): settled at this version on this grid. Arrays measured before are
// dropped: they described a reading this version no longer makes.
export function recordStructureUnmeasurable(id: string, version: number, reason: string, gridAt: string, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_structure (track_id, status, version, reason, attempts, measured_at, grid_at, bars_json)
     VALUES (?, 'unmeasurable', ?, ?, 0, ?, ?, NULL)
     ON CONFLICT(track_id) DO UPDATE SET status = 'unmeasurable', version = excluded.version, reason = excluded.reason,
       attempts = 0, measured_at = excluded.measured_at, grid_at = excluded.grid_at, bars_json = NULL`,
  ).run(id, Math.round(version), reason.slice(0, 500), at, gridAt);
}

// An attempt that failed: one more attempt, the reason kept. A measured row
// stays (and stays 'ok', on the grid it was measured on). A failed row counts
// again from 1 on another grid.
export function recordStructureFailure(id: string, reason: string, gridAt: string, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_structure (track_id, status, version, reason, attempts, measured_at, grid_at)
     VALUES (?, 'failed', ?, ?, 1, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET reason = excluded.reason,
       attempts = CASE WHEN track_structure.status = 'ok' OR track_structure.grid_at IS excluded.grid_at
         THEN track_structure.attempts + 1 ELSE 1 END,
       status = CASE WHEN track_structure.status = 'ok' THEN 'ok' ELSE 'failed' END,
       grid_at = CASE WHEN track_structure.status = 'ok' THEN track_structure.grid_at ELSE excluded.grid_at END,
       measured_at = CASE WHEN track_structure.status = 'ok' THEN track_structure.measured_at ELSE excluded.measured_at END`,
  ).run(id, STRUCTURE_FACET_VERSION, reason.slice(0, 500), at, gridAt);
}

interface StructureRow {
  status: StructureStatus; version: number; reason: string | null; attempts: number;
  measured_at: string; grid_at: string | null; bars_json: string | null;
}

function parseStoredBars(json: string | null): StructureBars | null {
  if (!json) return null;
  try {
    return parseStructureBars(JSON.parse(json));
  } catch {
    return null;
  }
}

function toStructure(r: StructureRow): TrackStructure {
  return {
    status: r.status, version: r.version, reason: r.reason, attempts: r.attempts, measuredAt: r.measured_at,
    gridAt: r.grid_at, bars: parseStoredBars(r.bars_json),
  };
}

export function getStructure(id: string, d: Database.Database = requireDb()): TrackStructure | null {
  const r = d.prepare('SELECT * FROM track_structure WHERE track_id = ?').get(id) as StructureRow | undefined;
  return r ? toStructure(r) : null;
}

// Ids with a measured structure, for the report.
export function measuredStructureIds(): string[] {
  return (requireDb().prepare(`SELECT track_id FROM track_structure WHERE status = 'ok' ORDER BY track_id`).all() as Array<{ track_id: string }>)
    .map((r) => r.track_id);
}

// ID rotation: the old id's row moves to the new id unless it has its own.
export function moveStructureRow(d: Database.Database, oldId: string, newId: string): void {
  d.prepare(`INSERT OR IGNORE INTO track_structure (track_id, status, version, reason, attempts, measured_at, grid_at, bars_json)
    SELECT ?, status, version, reason, attempts, measured_at, grid_at, bars_json FROM track_structure WHERE track_id = ?`)
    .run(newId, oldId);
  d.prepare('DELETE FROM track_structure WHERE track_id = ?').run(oldId);
}

export function deleteStructureRow(d: Database.Database, id: string): void {
  d.prepare('DELETE FROM track_structure WHERE track_id = ?').run(id);
}
