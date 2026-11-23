// The whole-track beat grid (the analyzer's `grid` facet, Beat This!): its own
// table, one row per track, holding the fitted grid and the facet's whole
// state (status, reason, attempts).
//
// Why a table of its own and its own attempt count:
//   - The grid is opt-in (`npm run analyze -- --facets grid`, heavy analyzer
//     only), so an upgrade changes nothing a station plays: with no grid
//     measured, `bpm`, `beats_json` and `bars_json` stay the head analysis's.
//   - A measured grid that passes music/grid-policy.ts replaces them
//     (tracks.applyGridToTrack). The head analysis's own values are kept here
//     (`head_*`, while `applied` = 1), so `npm run grid-apply -- --revert`
//     restores them; a reverted row is `applied` = -1 and stays reverted
//     until `npm run grid-apply` is run again.
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

// Which rule placed a half-bar grid's bar line (analyze_worker.py
// place_half_bar): the drop, or the model's majority without a clear one.
export type GridPhaseSource = 'drop' | 'majority';
export const phaseSourceOrNull = (v: unknown): GridPhaseSource | null => (v === 'drop' || v === 'majority' ? v : null);

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
  // The half-bar case (music/grid-policy.ts): the main segment's downbeats on
  // the dominant phase or two beats away (null when the worker did not report
  // it: a grid measured before it did, or not 4/4); in that case the drop's
  // jump in dB (null when not computed) and which rule placed the bar line
  // (null outside the case).
  downbeatHalfbar: number | null;
  downbeatDropDb: number | null;
  downbeatPhase: GridPhaseSource | null;
  mainShare: number | null;
  decodedMs: number | null;
  measuredAt: string;
  // 1: written over the head's values (kept in head*); 0: not; -1: reverted
  // by the operator, never re-applied until `npm run grid-apply`.
  applied: GridApplied;
  headBpm: number | null;
  headBeatsJson: string | null;
  headBarsJson: string | null;
  // The ending's {bpm, beats, bars} inside outro_json: the tail measurement's
  // own (kept) and what the grid wrote over it; both null when not written.
  headOutroJson: string | null;
  gridOutroJson: string | null;
}

export type GridApplied = -1 | 0 | 1;

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
  downbeatHalfbar: number | null;
  downbeatDropDb: number | null;
  downbeatPhase: GridPhaseSource | null;
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
    measured_at        TEXT    NOT NULL,
    applied            INTEGER NOT NULL DEFAULT 0,
    head_bpm           REAL,
    head_beats_json    TEXT,
    head_bars_json     TEXT,
    head_outro_json    TEXT,
    grid_outro_json    TEXT,
    downbeat_halfbar   REAL,
    downbeat_drop_db   REAL,
    downbeat_phase     TEXT
  ) WITHOUT ROWID`);
  // The ending's columns, then the half-bar case's, came after the
  // table shipped: added in place (null on every row measured before).
  const cols = new Set((d.prepare('PRAGMA table_info(track_grid)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const [c, type] of [['head_outro_json', 'TEXT'], ['grid_outro_json', 'TEXT'],
    ['downbeat_halfbar', 'REAL'], ['downbeat_drop_db', 'REAL'], ['downbeat_phase', 'TEXT']] as const) {
    if (!cols.has(c)) d.exec(`ALTER TABLE track_grid ADD COLUMN ${c} ${type}`);
  }
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
       segments_json, coverage, residual_ms, downbeat_agreement, downbeat_halfbar, downbeat_drop_db,
       downbeat_phase, main_share, decoded_ms, measured_at)
     VALUES (?, 'ok', ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET status = 'ok', version = excluded.version, reason = NULL, attempts = 0,
       engine = excluded.engine, model = excluded.model, bpm = excluded.bpm, beats_per_bar = excluded.beats_per_bar,
       segments_json = excluded.segments_json, coverage = excluded.coverage, residual_ms = excluded.residual_ms,
       downbeat_agreement = excluded.downbeat_agreement, downbeat_halfbar = excluded.downbeat_halfbar,
       downbeat_drop_db = excluded.downbeat_drop_db, downbeat_phase = excluded.downbeat_phase,
       main_share = excluded.main_share,
       decoded_ms = excluded.decoded_ms, measured_at = excluded.measured_at`,
  ).run(
    id, Math.round(a.version), a.engine, a.model, a.bpm, a.beatsPerBar, JSON.stringify(a.segments),
    finiteOrNull(a.coverage), finiteOrNull(a.residualMs), finiteOrNull(a.downbeatAgreement),
    finiteOrNull(a.downbeatHalfbar), finiteOrNull(a.downbeatDropDb), phaseSourceOrNull(a.downbeatPhase),
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
       coverage = NULL, residual_ms = NULL, downbeat_agreement = NULL, downbeat_halfbar = NULL,
       downbeat_drop_db = NULL, downbeat_phase = NULL, main_share = NULL, decoded_ms = NULL, measured_at = excluded.measured_at`,
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
  downbeat_halfbar?: number | null; downbeat_drop_db?: number | null; downbeat_phase?: string | null;
  main_share: number | null; decoded_ms: number | null; measured_at: string;
  applied: number; head_bpm: number | null; head_beats_json: string | null; head_bars_json: string | null;
  head_outro_json: string | null; grid_outro_json: string | null;
}

// The stored segments, malformed ones dropped (also read by structure.ts).
export function parseSegments(json: string | null): GridSegment[] {
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
    downbeatHalfbar: r.downbeat_halfbar ?? null, downbeatDropDb: r.downbeat_drop_db ?? null,
    downbeatPhase: phaseSourceOrNull(r.downbeat_phase),
    mainShare: r.main_share, decodedMs: r.decoded_ms, measuredAt: r.measured_at,
    applied: (r.applied === 1 ? 1 : r.applied === -1 ? -1 : 0), headBpm: r.head_bpm,
    headBeatsJson: r.head_beats_json, headBarsJson: r.head_bars_json,
    headOutroJson: r.head_outro_json ?? null, gridOutroJson: r.grid_outro_json ?? null,
  };
}

export function getGrid(id: string, d: Database.Database = requireDb()): TrackGrid | null {
  const r = d.prepare('SELECT * FROM track_grid WHERE track_id = ?').get(id) as GridRow | undefined;
  return r ? toGrid(r) : null;
}

// What hot-mix-policy.ts mixTempoOf reads of one track: its stored tempo and
// its grid row's state. One primary-key read; null when the track has no
// library row. Typed here, the policy's MixTempoFacts.
export interface MixTempoRow {
  bpm: number | null;
  grid: { status: GridStatus; applied: GridApplied } | null;
}

const appliedOf = (v: number | null): GridApplied => (v === 1 ? 1 : v === -1 ? -1 : 0);

export function mixTempoFacts(id: string): MixTempoRow | null {
  const r = requireDb().prepare(
    `SELECT t.bpm AS bpm, g.status AS g_status, g.applied AS g_applied
     FROM tracks t LEFT JOIN track_grid g ON g.track_id = t.id WHERE t.id = ?`,
  ).get(id) as { bpm: number | null; g_status: GridStatus | null; g_applied: number | null } | undefined;
  if (!r) return null;
  return { bpm: r.bpm, grid: r.g_status == null ? null : { status: r.g_status, applied: appliedOf(r.g_applied) } };
}

// Every applied grid's MixTempoRow, for the show editor's Hot Mix count: one
// pass, by id. Only an applied grid (status ok) gives a mix tempo, so no other
// track needs a row here.
export function measuredMixTempoFacts(): Map<string, MixTempoRow> {
  const rows = requireDb().prepare(
    `SELECT g.track_id AS id, t.bpm AS bpm
     FROM track_grid g JOIN tracks t ON t.id = g.track_id WHERE g.status = 'ok' AND g.applied = 1`,
  ).all() as Array<{ id: string; bpm: number | null }>;
  const out = new Map<string, MixTempoRow>();
  for (const r of rows) out.set(r.id, { bpm: r.bpm, grid: { status: 'ok', applied: 1 } });
  return out;
}

// Every measured grid, for the dry-run report: (id, grid).
export function allMeasuredGrids(): Array<{ id: string; grid: TrackGrid }> {
  const rows = requireDb()
    .prepare(`SELECT * FROM track_grid WHERE status = 'ok' AND segments_json IS NOT NULL`)
    .all() as Array<GridRow & { track_id: string }>;
  return rows.map((r) => ({ id: r.track_id, grid: toGrid(r) }));
}

// Every grid row the head's values were kept for (applied = 1), or every
// operator-reverted one (-1), by id.
export function gridIdsApplied(state: GridApplied): string[] {
  return (requireDb().prepare('SELECT track_id FROM track_grid WHERE applied = ? ORDER BY track_id').all(state) as Array<{ track_id: string }>)
    .map((r) => r.track_id);
}

// What `npm run grid-apply`'s report reads of one track: a narrow
// primary-key read (the row's analysis JSON is never touched). Null when the
// track has no library row.
export function gridApplyTrackFacts(id: string): { artist: string; title: string; bpm: number | null } | null {
  const r = requireDb().prepare('SELECT artist, title, bpm FROM tracks WHERE id = ?').get(id) as
    { artist: string | null; title: string | null; bpm: number | null } | undefined;
  return r ? { artist: r.artist ?? '', title: r.title ?? '', bpm: r.bpm } : null;
}

// Ids with a measured grid, for `npm run grid-apply`.
export function measuredGridIds(): string[] {
  return (requireDb().prepare(`SELECT track_id FROM track_grid WHERE status = 'ok' ORDER BY track_id`).all() as Array<{ track_id: string }>)
    .map((r) => r.track_id);
}

// The grid's bookkeeping of what it replaced: `applied` and the head's own
// values (null unless applied = 1). Written only by tracks.applyGridToTrack and
// its revert.
export function setGridApplied(
  d: Database.Database, id: string, applied: GridApplied,
  head: { bpm: number | null; beatsJson: string | null; barsJson: string | null } | null,
): void {
  d.prepare('UPDATE track_grid SET applied = ?, head_bpm = ?, head_beats_json = ?, head_bars_json = ? WHERE track_id = ?')
    .run(applied, head?.bpm ?? null, head?.beatsJson ?? null, head?.barsJson ?? null, id);
}

// A head write replaced tracks.bpm/beats/bars with fresh head values: what was
// kept as the head's is stale. An operator revert (-1) stays reverted.
export function forgetGridHead(d: Database.Database, id?: string): void {
  const sql = 'UPDATE track_grid SET applied = 0, head_bpm = NULL, head_beats_json = NULL, head_bars_json = NULL WHERE applied = 1';
  if (id == null) d.prepare(sql).run();
  else d.prepare(`${sql} AND track_id = ?`).run(id);
}

// The ending's bookkeeping (tracks.applyGridToTrack): both null = not written.
export function setGridOutro(d: Database.Database, id: string, headJson: string | null, gridJson: string | null): void {
  d.prepare('UPDATE track_grid SET head_outro_json = ?, grid_outro_json = ? WHERE track_id = ?').run(headJson, gridJson, id);
}

// ID rotation: the old id's row moves to the new id unless it has its own.
// The columns are named on both sides: a positional copy depends on the
// table's physical column order, which columns added in place
// (ensureGridTable) make differ between an upgraded and a fresh table, and a
// mismatch shifts every later value into the wrong column without an error.
const GRID_COPY_COLUMNS = [
  'status', 'version', 'reason', 'attempts', 'engine', 'model', 'bpm', 'beats_per_bar', 'segments_json',
  'coverage', 'residual_ms', 'downbeat_agreement', 'downbeat_halfbar', 'downbeat_drop_db', 'downbeat_phase',
  'main_share', 'decoded_ms', 'measured_at', 'applied', 'head_bpm', 'head_beats_json', 'head_bars_json', 'head_outro_json',
  'grid_outro_json',
].join(', ');
export function moveGridRow(d: Database.Database, oldId: string, newId: string): void {
  d.prepare(`INSERT OR IGNORE INTO track_grid (track_id, ${GRID_COPY_COLUMNS})
     SELECT ?, ${GRID_COPY_COLUMNS} FROM track_grid WHERE track_id = ?`)
    .run(newId, oldId);
  d.prepare('DELETE FROM track_grid WHERE track_id = ?').run(oldId);
}

export function deleteGridRow(d: Database.Database, id: string): void {
  d.prepare('DELETE FROM track_grid WHERE track_id = ?').run(id);
}
