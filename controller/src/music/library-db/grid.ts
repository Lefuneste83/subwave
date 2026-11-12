// The whole-track beat grid (the analyzer's `grid` facet, Beat This!): its own
// table, one row per track, holding the fitted grid and the facet's whole
// state (status, reason, attempts).
//
// Why a table of its own and its own attempt count:
//   - The grid is opt-in (`npm run analyze -- --facets grid`, heavy analyzer
//     only). Nothing else reads it until the operator approves the dry-run
//     report (music/grid-report.ts) and turns the adapter on, so an upgrade
//     changes nothing a station plays: today's `bpm`, `beats_json` and
//     `bars_json` stay the head analysis's own.
//   - The track's shared failure count (`analyze_fail_count`) gates every
//     regular analysis retry and is copied onto each facet that has no row
//     (library-db/facets.ts deriveFacetRows). A grid failure counted there
//     would stop a track's regular analysis, and a regular failure would mark
//     a grid nobody asked for as failed. So the grid's failures are its own,
//     and its facet row is derived from this table alone.
//   - Rolling back is dropping the table.
//
// Storage is compact by design (operator, 11 Oct: "must not blow up the DB"):
// a fitted grid is a few segments (anchor + period), about 300 bytes a track,
// never one value per beat.
//
// The row follows the track: a replaced file drops it with the other audio
// measurements (tracks.clearTrackAudio), an ID rotation moves it (the new id's
// own row wins, id-adoption.ts), and a pruned track takes it along.

import type Database from 'better-sqlite3';
import { requireDb } from './handle.js';

// The analyzer's grid answer version (analyze_worker.GRID_VERSION). Bump with
// it: rows written by an older version stay `due` for `--facets grid`.
export const GRID_FACET_VERSION = 1;

export type GridStatus = 'ok' | 'unmeasurable' | 'failed';

// One segment of the fitted grid: beat k sits at anchorMs + k * periodUs / 1000
// for k in 0..beats-1. `downbeatMs` is a beat of that grid that starts a bar
// (null when the downbeats did not settle on one phase).
export interface GridSegment {
  anchorMs: number;
  periodUs: number;
  beats: number;
  downbeatMs: number | null;
}

export interface TrackGrid {
  status: GridStatus;
  version: number;
  reason: string | null;
  attempts: number;
  engine: string | null;
  model: string | null;
  bpm: number | null;
  beatsPerBar: number | null;
  segments: GridSegment[];
  coverage: number | null;
  residualMs: number | null;
  downbeatAgreement: number | null;
  mainShare: number | null;
  decodedMs: number | null;
  measuredAt: string;
}

// The analyzer's `grid` data, as parsed by music/analyzer.ts parseGridAnswer.
export interface GridAnswer {
  version: number;
  engine: string;
  model: string | null;
  bpm: number;
  beatsPerBar: number | null;
  segments: GridSegment[];
  coverage: number | null;
  residualMs: number | null;
  downbeatAgreement: number | null;
  mainShare: number | null;
  decodedMs: number | null;
}

// Created on every open (schema.ts migrate → facets.ensureFacetStatus), before
// the facet table is derived: FACET_SOURCE_SELECT reads it. Idempotent.
export function ensureGridTable(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS track_grid (
    track_id           TEXT    PRIMARY KEY,
    status             TEXT    NOT NULL CHECK (status IN ('ok','unmeasurable','failed')),
    version            INTEGER NOT NULL,
    reason             TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    engine             TEXT,
    model              TEXT,
    bpm                REAL,
    beats_per_bar      INTEGER,
    segments_json      TEXT,
    coverage           REAL,
    residual_ms        REAL,
    downbeat_agreement REAL,
    main_share         REAL,
    decoded_ms         INTEGER,
    measured_at        TEXT    NOT NULL
  ) WITHOUT ROWID`);
}

// The facet derivation's view of this table, as columns of a `FROM tracks`
// select (FACET_SOURCE_SELECT): one primary-key probe each.
export const GRID_SOURCE_SELECT =
  `(SELECT g.status   FROM track_grid g WHERE g.track_id = tracks.id) AS grid_status,
   (SELECT g.version  FROM track_grid g WHERE g.track_id = tracks.id) AS grid_version,
   (SELECT g.reason   FROM track_grid g WHERE g.track_id = tracks.id) AS grid_reason,
   (SELECT g.attempts FROM track_grid g WHERE g.track_id = tracks.id) AS grid_attempts`;

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A measured grid: replaces whatever was stored, attempts back to 0.
export function writeGrid(id: string, a: GridAnswer, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_grid (track_id, status, version, reason, attempts, engine, model, bpm, beats_per_bar,
       segments_json, coverage, residual_ms, downbeat_agreement, main_share, decoded_ms, measured_at)
     VALUES (?, 'ok', ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET status = 'ok', version = excluded.version, reason = NULL, attempts = 0,
       engine = excluded.engine, model = excluded.model, bpm = excluded.bpm, beats_per_bar = excluded.beats_per_bar,
       segments_json = excluded.segments_json, coverage = excluded.coverage, residual_ms = excluded.residual_ms,
       downbeat_agreement = excluded.downbeat_agreement, main_share = excluded.main_share,
       decoded_ms = excluded.decoded_ms, measured_at = excluded.measured_at`,
  ).run(
    id, Math.round(a.version), a.engine, a.model, a.bpm, a.beatsPerBar, JSON.stringify(a.segments),
    finiteOrNull(a.coverage), finiteOrNull(a.residualMs), finiteOrNull(a.downbeatAgreement),
    finiteOrNull(a.mainShare), a.decodedMs == null ? null : Math.round(a.decodedMs), at,
  );
}

// The analyzer read the file and found no grid (too short, no steady pulse):
// a settled answer at this version, not retried by `--where needs`. A grid
// measured before is dropped: it described a reading this version no longer
// makes.
export function recordGridUnmeasurable(id: string, version: number, reason: string, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_grid (track_id, status, version, reason, attempts, measured_at)
     VALUES (?, 'unmeasurable', ?, ?, 0, ?)
     ON CONFLICT(track_id) DO UPDATE SET status = 'unmeasurable', version = excluded.version, reason = excluded.reason,
       attempts = 0, engine = NULL, model = NULL, bpm = NULL, beats_per_bar = NULL, segments_json = NULL,
       coverage = NULL, residual_ms = NULL, downbeat_agreement = NULL, main_share = NULL, decoded_ms = NULL,
       measured_at = excluded.measured_at`,
  ).run(id, Math.round(version), reason.slice(0, 500), at);
}

// An attempt that failed: one more attempt, the reason kept. A grid already
// measured stays (and stays 'ok'): the failure says nothing against it.
export function recordGridFailure(id: string, reason: string, at = new Date().toISOString()): void {
  requireDb().prepare(
    `INSERT INTO track_grid (track_id, status, version, reason, attempts, measured_at)
     VALUES (?, 'failed', ?, ?, 1, ?)
     ON CONFLICT(track_id) DO UPDATE SET attempts = track_grid.attempts + 1, reason = excluded.reason,
       status = CASE WHEN track_grid.status = 'ok' THEN 'ok' ELSE 'failed' END,
       measured_at = CASE WHEN track_grid.status = 'ok' THEN track_grid.measured_at ELSE excluded.measured_at END`,
  ).run(id, GRID_FACET_VERSION, reason.slice(0, 500), at);
}

interface GridRow {
  status: GridStatus; version: number; reason: string | null; attempts: number; engine: string | null;
  model: string | null; bpm: number | null; beats_per_bar: number | null; segments_json: string | null;
  coverage: number | null; residual_ms: number | null; downbeat_agreement: number | null;
  main_share: number | null; decoded_ms: number | null; measured_at: string;
}

function parseSegments(json: string | null): GridSegment[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s) =>
      s && Number.isFinite(s.anchorMs) && Number.isFinite(s.periodUs) && s.periodUs > 0 && Number.isFinite(s.beats)) : [];
  } catch {
    return [];
  }
}

function toGrid(r: GridRow): TrackGrid {
  return {
    status: r.status, version: r.version, reason: r.reason, attempts: r.attempts, engine: r.engine,
    model: r.model, bpm: r.bpm, beatsPerBar: r.beats_per_bar, segments: parseSegments(r.segments_json),
    coverage: r.coverage, residualMs: r.residual_ms, downbeatAgreement: r.downbeat_agreement,
    mainShare: r.main_share, decodedMs: r.decoded_ms, measuredAt: r.measured_at,
  };
}

export function getGrid(id: string): TrackGrid | null {
  const r = requireDb().prepare('SELECT * FROM track_grid WHERE track_id = ?').get(id) as GridRow | undefined;
  return r ? toGrid(r) : null;
}

// Every measured grid, for the dry-run report: (id, grid).
export function allMeasuredGrids(): Array<{ id: string; grid: TrackGrid }> {
  const rows = requireDb()
    .prepare(`SELECT * FROM track_grid WHERE status = 'ok' AND segments_json IS NOT NULL`)
    .all() as Array<GridRow & { track_id: string }>;
  return rows.map((r) => ({ id: r.track_id, grid: toGrid(r) }));
}

// ID rotation: the old id's row moves to the new id unless it has its own.
export function moveGridRow(d: Database.Database, oldId: string, newId: string): void {
  d.prepare('INSERT OR IGNORE INTO track_grid SELECT ?, status, version, reason, attempts, engine, model, bpm, beats_per_bar, segments_json, coverage, residual_ms, downbeat_agreement, main_share, decoded_ms, measured_at FROM track_grid WHERE track_id = ?')
    .run(newId, oldId);
  d.prepare('DELETE FROM track_grid WHERE track_id = ?').run(oldId);
}

export function deleteGridRow(d: Database.Database, id: string): void {
  d.prepare('DELETE FROM track_grid WHERE track_id = ?').run(id);
}
