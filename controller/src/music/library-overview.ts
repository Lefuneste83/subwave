// The Library page's counts line: what the library holds, what can air, what
// the never-play list keeps off, how much of it the station actually plays,
// and what is waiting on the operator. Every figure is a library.db read; the
// music server's own count stays `coverage.total`, which only refresh() walks.
//
// The library figure (`library`) compares with the server's count: both hold
// blocked tracks (the mirror keeps their rows, badged in the admin, and the
// count walks with `includeBlocked`), and both leave the station archive out.
// `library = canAir + blocked.total` always holds.
//
// Cost and caching: see "The cache the page reads" below. The page never
// waits on a count.

import * as db from './library-db.js';
import * as blocklist from './blocklist.js';
import { countEraToReview } from './era-review.js';
import { effectiveMinTrackSec, effectiveTrackLengthLimits, resolveActiveShow } from '../settings.js';

const MIN_RECOUNT_MS = 60_000;
export const AIRED_WINDOW_DAYS = 30;

export interface LibraryOverview {
  /** Every row in the library mirror, blocked ones included. */
  library: number;
  /** The library minus the never-play list. */
  canAir: number;
  /** Of canAir: mood & energy tagged. */
  taggedCanAir: number;
  /** Of canAir: tagged, BPM and key measured, loudness measured over the whole file. */
  djReady: number;
  /** Rows the never-play list blocks now, by what blocks them (most specific first). */
  blocked: { total: number; track: number; album: number; artist: number; rule: number };
  /**
   * The length limits the show on air applies when picking (exclude-mode cap,
   * and the floor), and how many of canAir pass them. Null when none applies.
   */
  lengthLimits: { show: string | null; minSec: number | null; maxSec: number | null; within: number } | null;
  /** Distinct canAir tracks in the play history. */
  aired: { windowDays: number; recent: number; ever: number; never: number; since: string | null };
  /** What only the operator can settle. */
  attention: { eraAlbums: number; unmeasurable: number; yearFailed: number; analysisFailed: number; total: number };
  computedAt: string;
}

export interface OverviewRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumId: string | null;
  artistId: string | null;
  genres: string[] | null;
  genre: string | null;
  moods: string[] | null;
  audioMoods: string[] | null;
  lastfmTags: string[] | null;
  durationSec: number | null;
  tagged: boolean;
  ready: boolean;
}

type Hit = ReturnType<typeof blocklist.hitOf>;

/** Pure: the library half of the overview from projected rows and a blocklist matcher. */
export function summariseRows(
  rows: readonly OverviewRow[],
  hitOf: (row: OverviewRow) => Hit,
  limits: { minSec: number | null; maxSec: number | null },
): {
  library: number; canAir: number; taggedCanAir: number; djReady: number;
  blocked: LibraryOverview['blocked']; within: number; canAirIds: Set<string>;
} {
  const blocked = { total: 0, track: 0, album: 0, artist: 0, rule: 0 };
  const canAirIds = new Set<string>();
  let taggedCanAir = 0;
  let djReady = 0;
  let within = 0;
  for (const r of rows) {
    const hit = hitOf(r);
    if (hit) {
      blocked.total++;
      if (hit.kind === 'rule') blocked.rule++;
      else blocked[hit.type]++;
      continue;
    }
    canAirIds.add(r.id);
    if (r.tagged) taggedCanAir++;
    if (r.ready) djReady++;
    // An unknown length passes, as it does at the picker's length filter.
    const d = r.durationSec;
    const okMin = limits.minSec == null || d == null || d >= limits.minSec;
    const okMax = limits.maxSec == null || d == null || d <= limits.maxSec;
    if (okMin && okMax) within++;
  }
  return { library: rows.length, canAir: canAirIds.size, taggedCanAir, djReady, blocked, within, canAirIds };
}

function parseList(v: unknown): string[] | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : null;
  } catch {
    return null;
  }
}

function hasColumn(cols: Set<string>, c: string): boolean {
  return cols.has(c);
}

/** The one row pass's SQL (exported so a test can pin its plan). */
export function overviewRowsSql(): string {
  const d = db.requireDb();
  const cols = new Set((d.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(c => c.name));
  // Whole-file loudness is `loudness_version >= 2`; a library without the
  // column has no whole-file figure, so nothing there is DJ-ready on it.
  const loud = hasColumn(cols, 'loudness_version')
    ? 'loudness_lufs IS NOT NULL AND COALESCE(loudness_version, 1) >= 2'
    : '0';
  // Exactly the columns of idx_tracks_overview, so SQLite walks that index
  // (SCAN … USING COVERING INDEX) and never the wide rows (#1937). `genre` is
  // a generated column the index cannot carry: it is genres[0], rebuilt below.
  return `SELECT id, album_id, artist_id, artist, album, title, genres, moods,
      audio_moods, lastfm_tags, duration_sec,
      (${db.SQL_HAS_MOODS}) AS tagged,
      ((${db.SQL_HAS_MOODS}) AND bpm IS NOT NULL AND musical_key IS NOT NULL AND ${loud}) AS ready
    FROM tracks`;
}

function readRows(): OverviewRow[] {
  const raw = db.requireDb().prepare(overviewRowsSql()).all() as Array<Record<string, any>>;
  return raw.map(r => ({
    id: r.id,
    title: r.title ?? null,
    artist: r.artist ?? null,
    album: r.album ?? null,
    albumId: r.album_id ?? null,
    artistId: r.artist_id ?? null,
    genres: parseList(r.genres),
    genre: parseList(r.genres)?.[0] ?? null,
    moods: parseList(r.moods),
    audioMoods: parseList(r.audio_moods),
    lastfmTags: parseList(r.lastfm_tags),
    durationSec: typeof r.duration_sec === 'number' ? r.duration_sec : null,
    tagged: r.tagged === 1,
    ready: r.ready === 1,
  }));
}

function readAired(canAirIds: Set<string>, now: number): LibraryOverview['aired'] {
  const d = db.requireDb();
  const cutoff = new Date(now - AIRED_WINDOW_DAYS * 86_400_000).toISOString();
  const count = (sql: string, ...args: unknown[]) => {
    let n = 0;
    for (const r of d.prepare(sql).iterate(...args) as Iterable<{ id: string }>) if (canAirIds.has(r.id)) n++;
    return n;
  };
  const recent = count('SELECT DISTINCT track_id AS id FROM plays WHERE track_id IS NOT NULL AND played_at >= ?', cutoff);
  const ever = count('SELECT DISTINCT track_id AS id FROM plays WHERE track_id IS NOT NULL');
  const since = (d.prepare('SELECT MIN(played_at) AS t FROM plays').get() as { t: string | null }).t ?? null;
  return { windowDays: AIRED_WINDOW_DAYS, recent, ever, never: canAirIds.size - ever, since };
}

// Each part degrades to 0 on its own: a library without the era or facet
// tables (an older schema) still gets the rest of the line.
const safeCount = (f: () => number) => {
  try { return f(); } catch { return 0; }
};

/**
 * Era albums still under "To review": era-review's own count, through the
 * same rule as the Era tab's list (eraAlbumDone), read from indexes.
 */
function readEraToReview(): number {
  return safeCount(() => countEraToReview(db.requireDb()));
}

function readAttention(eraAlbums: number): LibraryOverview['attention'] {
  const d = db.requireDb();
  // `year` unmeasurable means no source knows the year: the Era tab already
  // carries those albums, so they are not counted twice here.
  // Tracks, not facet rows: one damaged file is often unmeasurable for
  // several facets, and the operator acts on files.
  const unmeasurable = safeCount(() => (d.prepare(
    `SELECT COUNT(DISTINCT track_id) AS n FROM track_facet_status WHERE status = 'unmeasurable' AND facet <> 'year'`,
  ).get() as { n: number }).n);
  const yearFailed = safeCount(() => (d.prepare(
    `SELECT COUNT(*) AS n FROM track_facet_status WHERE status = 'failed' AND facet = 'year'`,
  ).get() as { n: number }).n);
  const analysisFailed = safeCount(() => db.analysisFailedCount());
  return { eraAlbums, unmeasurable, yearFailed, analysisFailed, total: eraAlbums + unmeasurable + yearFailed + analysisFailed };
}

function activeLimits(): { show: string | null; minSec: number | null; maxSec: number | null } {
  const show = resolveActiveShow();
  // In cut mode the cap trims on air and excludes nothing, so only the
  // exclude-mode cap narrows what can be picked.
  const { selectionMaxSec } = effectiveTrackLengthLimits(show);
  const minSec = effectiveMinTrackSec(show);
  return { show: (show as { name?: string } | null)?.name ?? null, minSec, maxSec: selectionMaxSec };
}

type Limits = ReturnType<typeof activeLimits>;
type RowSummary = ReturnType<typeof summariseRows>;

function assemble(s: RowSummary, limits: Limits, eraAlbums: number, now: number): LibraryOverview {
  return {
    library: s.library,
    canAir: s.canAir,
    taggedCanAir: s.taggedCanAir,
    djReady: s.djReady,
    blocked: s.blocked,
    lengthLimits: limits.minSec == null && limits.maxSec == null
      ? null
      : { show: limits.show, minSec: limits.minSec, maxSec: limits.maxSec, within: s.within },
    aired: readAired(s.canAirIds, now),
    attention: readAttention(eraAlbums),
    computedAt: new Date(now).toISOString(),
  };
}

/** Everything at once, synchronously. Tests and one-off probes; the page reads getOverview(). */
export function computeOverview(now = Date.now()): LibraryOverview {
  const limits = activeLimits();
  return assemble(summariseRows(readRows(), r => blocklist.hitOf(r), limits), limits, readEraToReview(), now);
}

// ── The cache the page reads ────────────────────────────────────────────────
//
// The row pass reads every track, on the controller's only thread, which also
// feeds the mixer: about 1.3 s on a 72k-track library through the wide rows,
// so it reads idx_tracks_overview instead (stats.ts), and still never runs on
// the request. So the page never waits for them: getOverview() hands
// back the last snapshot at once (null before the first) and starts a refresh
// in the background, which yields between its parts so no single block runs
// longer than one of them. Each part recomputes only when its inputs moved:
//  - rows (can air, blocked, DJ-ready, length limits): the never-play list's
//    state, the limits in force, or the library's shape (row count, newest
//    rowid, and the caller's tagged/analysed counts); else every SLOW_TTL_MS;
//  - plays and the attention counts, Era albums included (30 ms together):
//    any commit, at most once per MIN_RECOUNT_MS, since every play commits.
const SLOW_TTL_MS = 30 * 60_000;

interface Snapshot {
  value: LibraryOverview;
  rows: { key: string; context: string; at: number; summary: RowSummary; limits: Limits };
  token: string;
  at: number;
}
let snap: Snapshot | null = null;
let inflight: Promise<void> | null = null;

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function shapeKey(hint: string): string {
  const r = db.requireDb().prepare('SELECT COUNT(*) AS n, MAX(rowid) AS m FROM tracks').get() as { n: number; m: number | null };
  return `${r.n}.${r.m ?? 0}.${hint}`;
}

async function refresh(hint: string): Promise<void> {
  const now = Date.now();
  const token = db.changeToken();
  const limits = activeLimits();
  const shape = shapeKey(hint);
  const context = contextKey();
  const rowsKey = `${shape}|${context}`;
  let rows = snap?.rows;
  if (!rows || rows.key !== rowsKey || now - rows.at > SLOW_TTL_MS) {
    rows = { key: rowsKey, context, at: now, limits, summary: summariseRows(readRows(), r => blocklist.hitOf(r), limits) };
    await yieldTurn();
  }
  snap = { value: assemble(rows.summary, rows.limits, readEraToReview(), now), rows, token, at: now };
}

/**
 * The last snapshot, at once; null before the first one lands (the line then
 * waits for the next poll) or when the library cannot be read. `hint` carries
 * counts the caller already has (tagged, analysed) so a tagging or analysis
 * run is noticed without a scan here.
 */
export function getOverview(hint = '', now = Date.now()): LibraryOverview | null {
  // A process without the library open (a test, a child) has nothing to count.
  if (!db.getDb()) return snap?.value ?? null;
  try {
    const stale = !snap
      || (snap.token !== db.changeToken() && now - snap.at >= MIN_RECOUNT_MS)
      || now - snap.at >= SLOW_TTL_MS
      || snap.rows.context !== contextKey();
    if (stale) void refreshOverview(hint);
  } catch (err) {
    console.warn(`[library-overview] ${(err as Error)?.message || err}`);
  }
  return snap?.value ?? null;
}

// What an operator changes (the list, or the show and its limits) is seen on
// the next poll, not after the minute.
function contextKey(): string {
  const l = activeLimits();
  return `${blocklist.stateKey()}|${l.minSec}|${l.maxSec}|${l.show}`;
}

/** Start (or join) a background refresh. Exported for tests and the recount button. */
export function refreshOverview(hint = ''): Promise<void> {
  if (!db.getDb()) return Promise.resolve();
  if (!inflight) {
    inflight = refresh(hint)
      .catch(err => { console.warn(`[library-overview] refresh failed: ${(err as Error)?.message || err}`); })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Test hook: wait for a refresh getOverview() may have started. */
export function _settled(): Promise<void> {
  return inflight ?? Promise.resolve();
}

/** Test hook. */
export function _resetOverviewCache(): void {
  snap = null;
}
