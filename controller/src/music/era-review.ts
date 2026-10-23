// Era review (C13): the operator surface over the anthology detector's
// verdict. era-suspect.ts owns the judgement; this module keys albums the way
// overrides are stored, applies an operator's override at walk time, answers
// the admin Library → Era tab's questions, and writes the CSV export.
//
// Album identity is the (album artist, album) pair folded to
// lowercase-trim and joined with NUL, so two artists with an identically
// named album stay two albums, and case or stray whitespace never mints a
// second override. Every consumer — the walk, the override application, the
// listing — must key through albumEraKey (or ERA_ALBUM_KEY_SQL in SQL), never
// a hand-rolled join.
//
// Functions take the better-sqlite3 handle explicitly rather than reaching
// through library-db, so the routes and tests share one code path.

import type Database from 'better-sqlite3';

export type EraVerdict = 'trusted' | 'suspect';

/** The override table's primary key for an (album artist, album) pair. */
export function albumEraKey(albumArtist: string | null | undefined, album: string | null | undefined): string {
  return `${(albumArtist ?? '').trim().toLowerCase()}\u0000${(album ?? '').trim().toLowerCase()}`;
}

/** SQL twin of albumEraKey over the tracks columns. Keep the two in step. */
export const ERA_ALBUM_KEY_SQL =
  "LOWER(TRIM(COALESCE(album_artist, ''))) || char(0) || LOWER(TRIM(COALESCE(album, '')))";

/** The selection both the listing and the CSV export answer over: tracks the
 *  walk marked untrusted, plus every track of an overridden album (a trusted
 *  override zeroes era_untrusted, and the operator still needs to find it). */
const ERA_SELECTION_SQL = `(t.era_untrusted = 1 OR o.album_key IS NOT NULL)`;

/** The per-track year state: the original-year lookup's answer, if any. */
const YEAR_STATE_SQL = `CASE
  WHEN t.original_year IS NOT NULL THEN 'resolved'
  WHEN t.original_year_checked_at IS NOT NULL THEN 'not found'
  ELSE 'unchecked'
END`;

export function loadEraOverrides(d: Database): Map<string, EraVerdict> {
  const rows = d.prepare(`SELECT album_key, verdict FROM era_override`).all() as
    Array<{ album_key: string; verdict: EraVerdict }>;
  return new Map(rows.map(r => [r.album_key, r.verdict]));
}

export interface EraWalkSong {
  albumArtist?: string | null;
  album?: string | null;
  albumEraUntrusted?: boolean | null;
  albumEraReason?: string | null;
}

export interface EraWalkFields {
  eraUntrusted: boolean | null;
  eraReason: string | null;
  albumArtist: string | null;
}

/**
 * The override-aware era fields one walked song contributes to its row. An
 * override replaces the walk's stored VERDICT; `eraReason` stays whatever the
 * walk computed — it is audit truth about why the detector flagged the album,
 * and an override must never rewrite it.
 */
export function eraWalkFields(
  song: EraWalkSong,
  overrides: ReadonlyMap<string, EraVerdict>,
): EraWalkFields {
  const albumArtist = song.albumArtist ?? null;
  const verdict = overrides.get(albumEraKey(albumArtist, song.album));
  return {
    eraUntrusted: verdict ? verdict === 'suspect' : (song.albumEraUntrusted ?? null),
    eraReason: song.albumEraReason ?? null,
    albumArtist,
  };
}

/**
 * Record, change, or remove an operator's verdict for one album, and apply it
 * to the existing rows immediately — the operator should not have to run a
 * walk for their click to take effect. An UPDATE restricted to rows whose
 * stored value actually changes, so text_vector_dirty is only set where the
 * era source text behind a vector genuinely moved (step 22's rule).
 *
 * `verdict: null` REMOVES the override and deliberately touches no track: the
 * next walk writes the un-overridden walk verdict again (eraWalkFields), and
 * silently re-deciding rows here would second-guess the walk's data.
 *
 * Returns what changed: flipped track count for a verdict, dropped override
 * rows for a removal.
 */
export function setEraOverride(d: Database, albumKey: string, verdict: EraVerdict | null): number {
  if (verdict === null) {
    return d.prepare(`DELETE FROM era_override WHERE album_key = ?`).run(albumKey).changes;
  }
  d.prepare(
    `INSERT INTO era_override (album_key, verdict, set_at) VALUES (?, ?, ?)
     ON CONFLICT(album_key) DO UPDATE SET verdict = excluded.verdict, set_at = excluded.set_at`,
  ).run(albumKey, verdict, new Date().toISOString());
  const target = verdict === 'suspect' ? 1 : 0;
  return d.prepare(
    `UPDATE tracks
        SET era_untrusted = ?, text_vector_dirty = 1
      WHERE ${ERA_ALBUM_KEY_SQL} = ?
        AND era_untrusted IS NOT ?`,
  ).run(target, albumKey, target).changes;
}

export interface EraAlbumRow {
  albumKey: string;
  album: string | null;
  albumArtist: string | null;
  /** The stored walk reason (audit truth); null when the walk never flagged
   *  it and only an override put this album on the list. */
  reason: string | null;
  tracks: number;
  yearResolved: number;
  yearNotFound: number;
  yearUnchecked: number;
  /** The album's own release-year tag, as the walk stored it. */
  year: number | null;
  overridden: boolean;
}

export function listEraAlbums(d: Database): EraAlbumRow[] {
  const rows = d.prepare(
    `SELECT
       ${ERA_ALBUM_KEY_SQL} AS era_album_key,
       MAX(t.album) AS album,
       MAX(t.album_artist) AS album_artist,
       MAX(t.era_reason) AS era_reason,
       COUNT(*) AS tracks,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'resolved' THEN 1 ELSE 0 END) AS year_resolved,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'not found' THEN 1 ELSE 0 END) AS year_not_found,
       SUM(CASE WHEN ${YEAR_STATE_SQL} = 'unchecked' THEN 1 ELSE 0 END) AS year_unchecked,
       MAX(t.year) AS year,
       MAX(CASE WHEN o.album_key IS NOT NULL THEN 1 ELSE 0 END) AS overridden
     FROM tracks t
     LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
     WHERE ${ERA_SELECTION_SQL}
     GROUP BY era_album_key
     ORDER BY tracks DESC, era_album_key ASC`,
  ).all() as Array<{
    era_album_key: string; album: string | null; album_artist: string | null; era_reason: string | null;
    tracks: number; year_resolved: number; year_not_found: number; year_unchecked: number;
    year: number | null; overridden: number;
  }>;
  return rows.map(r => ({
    albumKey: r.era_album_key,
    album: r.album,
    albumArtist: r.album_artist,
    reason: r.era_reason,
    tracks: r.tracks,
    yearResolved: r.year_resolved,
    yearNotFound: r.year_not_found,
    yearUnchecked: r.year_unchecked,
    year: r.year,
    overridden: !!r.overridden,
  }));
}

export interface EraSummary {
  albums: number;
  tracks: number;
  /** Tracks per stored walk reason (unflagged override tracks carry none). */
  byReason: Record<string, number>;
  overridden: number;
}

export function countEraSummary(d: Database): EraSummary {
  const totals = d.prepare(
    `SELECT
       COUNT(DISTINCT ${ERA_ALBUM_KEY_SQL}) AS albums,
       COUNT(*) AS tracks,
       COUNT(DISTINCT CASE WHEN o.album_key IS NOT NULL THEN ${ERA_ALBUM_KEY_SQL} END) AS overridden
     FROM tracks t
     LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
     WHERE ${ERA_SELECTION_SQL}`,
  ).get() as { albums: number; tracks: number; overridden: number };
  const reasons = d.prepare(
    `SELECT t.era_reason AS reason, COUNT(*) AS n
       FROM tracks t
       LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
      WHERE ${ERA_SELECTION_SQL} AND t.era_reason IS NOT NULL
      GROUP BY t.era_reason`,
  ).all() as Array<{ reason: string; n: number }>;
  return {
    albums: totals.albums,
    tracks: totals.tracks,
    byReason: Object.fromEntries(reasons.map(r => [r.reason, r.n])),
    overridden: totals.overridden,
  };
}

function csvField(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  // Quote only where RFC4180 demands it; keep plain fields bare for the eye.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC4180 export of every track on an era-suspect album (same selection as
 *  listEraAlbums), one row per track. The operator reviews the tail of it in
 *  a spreadsheet and brings the album back for the next walk to re-read. */
export function exportEraCsv(d: Database): string {
  const header = 'id,artist,title,album,album_artist,era_reason,overridden,year,original_year,year_state,file_path,file_suffix,bit_rate,file_size,duration_sec';
  const rows = d.prepare(
    `SELECT t.id, t.artist, t.title, t.album, t.album_artist, t.era_reason,
            CASE WHEN o.album_key IS NOT NULL THEN 1 ELSE 0 END AS overridden,
            t.year, t.original_year,
            ${YEAR_STATE_SQL} AS year_state,
            t.file_path, t.file_suffix, t.bit_rate, t.file_size, t.duration_sec
       FROM tracks t
       LEFT JOIN era_override o ON o.album_key = ${ERA_ALBUM_KEY_SQL}
      WHERE ${ERA_SELECTION_SQL}
      ORDER BY t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.id`,
  ).all() as Array<Record<string, unknown>>;
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.id, r.artist, r.title, r.album, r.album_artist, r.era_reason, r.overridden,
      r.year, r.original_year, r.year_state, r.file_path, r.file_suffix,
      r.bit_rate, r.file_size, r.duration_sec,
    ].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
