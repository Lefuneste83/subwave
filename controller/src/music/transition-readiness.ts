// Library → Transitions: the count behind the tab. One pass over every track
// (tracks + its grid and structure rows), each track classified by
// music/transition-readiness-policy.ts, tallied overall and per Hot Mix show.
//
// Cost and caching (the counts-line rule: a library-wide count never runs on
// the read path). The route hands back the last snapshot at once (null before
// the first) and asks for a refresh in the background when it may be stale.
// The refresh starts after the request's turn, reads the library in keyset
// chunks of CHUNK rows (never a held iterator: the connection must stay free
// for the mixer's reads between chunks), and yields between them, so no block
// on the controller's thread runs longer than one chunk. The heavy part is the
// structure's bar arrays (a few KB a track), parsed only for a track that has
// a Hot Mix tempo and trusted bars (`bars` is a getter the policy reads last).
//
// When it recounts: the snapshot is looked at again on a poll once the
// library committed anything and MIN_RECOUNT_MS passed (every play commits),
// or after SLOW_TTL_MS, or at once when the Hot Mix shows changed. A look
// first reads the inputs' key (row counts, newest grid and structure, applied
// grids, stems, the stored tempos, the shows), a few index scans, and recounts
// only when it moved.

import * as db from './library-db.js';
import { parseSegments, phaseSourceOrNull, type GridApplied, type GridStatus } from './library-db/grid.js';
import { parseStoredBars, type StructureBars, type StructureStatus } from './library-db/structure.js';
import * as settings from '../settings.js';
import { hotMixOf } from './hot-mix-policy.js';
import { ReadinessTally, emptyShowTiers, readinessOf, type ReadinessFacts, type ShowTally } from './transition-readiness-policy.js';
import type { TransitionReadiness } from '../schemas/transition-readiness.js';

const CHUNK = 500;
const MIN_RECOUNT_MS = 60_000;
const SLOW_TTL_MS = 30 * 60_000;

interface Row {
  id: string;
  bpm: number | null;
  stems: number;
  g_status: GridStatus | null;
  g_applied: number | null;
  g_bpm: number | null;
  g_bpb: number | null;
  g_segments: string | null;
  g_coverage: number | null;
  g_agree: number | null;
  g_half: number | null;
  g_drop: number | null;
  g_phase: string | null;
  g_decoded: number | null;
  g_at: string | null;
  s_status: StructureStatus | null;
  s_reason: string | null;
  s_grid_at: string | null;
  s_bars: string | null;
}

// One chunk of the pass, after `id`. The tracks side walks
// idx_tracks_transitions (id, bpm, stems_at) and never the wide rows; each
// track's grid and structure rows are primary-key probes. Exported so a test
// can pin the plan.
export const TRANSITION_ROWS_SQL = `SELECT t.id AS id, t.bpm AS bpm, (t.stems_at IS NOT NULL) AS stems,
    g.status AS g_status, g.applied AS g_applied, g.bpm AS g_bpm, g.beats_per_bar AS g_bpb,
    g.segments_json AS g_segments, g.coverage AS g_coverage, g.downbeat_agreement AS g_agree,
    g.downbeat_halfbar AS g_half, g.downbeat_drop_db AS g_drop, g.downbeat_phase AS g_phase,
    g.decoded_ms AS g_decoded, g.measured_at AS g_at,
    s.status AS s_status, s.reason AS s_reason, s.grid_at AS s_grid_at,
    CASE WHEN s.status = 'ok' THEN s.bars_json END AS s_bars
  FROM tracks t
  LEFT JOIN track_grid g ON g.track_id = t.id
  LEFT JOIN track_structure s ON s.track_id = t.id
  WHERE t.id > ? ORDER BY t.id LIMIT ?`;

const appliedOf = (v: number | null): GridApplied => (v === 1 ? 1 : v === -1 ? -1 : 0);

export function factsOf(r: Row): ReadinessFacts {
  const grid = r.g_status == null ? null : {
    status: r.g_status,
    applied: appliedOf(r.g_applied),
    bpm: r.g_bpm,
    beatsPerBar: r.g_bpb,
    segments: parseSegments(r.g_segments),
    coverage: r.g_coverage,
    downbeatAgreement: r.g_agree,
    downbeatHalfbar: r.g_half,
    downbeatDropDb: r.g_drop,
    downbeatPhase: phaseSourceOrNull(r.g_phase),
    decodedMs: r.g_decoded,
    measuredAt: r.g_at ?? '',
  };
  let parsed: StructureBars | null | undefined;
  const json = r.s_bars;
  const structure = r.s_status == null ? null : {
    status: r.s_status,
    reason: r.s_reason,
    gridAt: r.s_grid_at,
    get bars(): StructureBars | null {
      if (parsed === undefined) parsed = parseStoredBars(json);
      return parsed;
    },
  };
  return { bpm: r.bpm, grid, structure };
}

interface HotMixShowRef { id: string; name: string; hm: NonNullable<ReturnType<typeof hotMixOf>> }

function hotMixShows(): HotMixShowRef[] {
  const out: HotMixShowRef[] = [];
  for (const show of (settings.get().shows ?? []) as Array<{ id?: unknown; name?: unknown; hotMix?: unknown }>) {
    const hm = hotMixOf(show);
    if (!hm) continue;
    const id = typeof show.id === 'string' && show.id ? show.id : String(show.name ?? '');
    out.push({ id, name: typeof show.name === 'string' && show.name ? show.name : id, hm });
  }
  return out;
}

const showsKeyOf = (shows: HotMixShowRef[]) => JSON.stringify(shows.map((s) => [s.id, s.name, s.hm]));

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

let passes = 0;

/** The whole count, yielding between chunks. */
export async function countTransitionReadiness(now = Date.now()): Promise<TransitionReadiness> {
  passes++;
  const started = performance.now();
  const shows = hotMixShows();
  const showTallies: ShowTally[] = shows.map((s) => ({ ...s, tiers: emptyShowTiers(), outByStoredTempo: 0 }));
  const tally = new ReadinessTally(showTallies);
  const stmt = db.requireDb().prepare(TRANSITION_ROWS_SQL);
  let after = '';
  for (;;) {
    const rows = stmt.all(after, CHUNK) as Row[];
    for (const r of rows) {
      tally.add(readinessOf(factsOf(r)), { stems: r.stems === 1, storedBpm: r.bpm });
    }
    if (rows.length < CHUNK) break;
    after = rows[rows.length - 1].id;
    await yieldTurn();
  }
  const durationMs = Math.round(performance.now() - started);
  return {
    library: tally.library,
    tiers: tally.result(),
    shows: showTallies.map((s) => ({
      id: s.id,
      name: s.name,
      maxStepPct: s.hm.maxStepPct,
      curve: s.hm.curve.length
        ? { lo: Math.min(...s.hm.curve.map((p) => p.bpm)), hi: Math.max(...s.hm.curve.map((p) => p.bpm)) }
        : null,
      phraseMix: s.hm.phraseMix,
      tiers: s.tiers,
      outByStoredTempo: s.outByStoredTempo,
    })),
    computedAt: new Date(now).toISOString(),
    durationMs,
  };
}

// What the count reads, cheaply: a recount runs only when this moved.
function inputsKey(showsKey: string): string {
  const d = db.requireDb();
  const one = (sql: string) => JSON.stringify(Object.values(d.prepare(sql).get() as object));
  return [
    one('SELECT COUNT(*), MAX(rowid), TOTAL(bpm), SUM(stems_at IS NOT NULL) FROM tracks'),
    one('SELECT COUNT(*), MAX(measured_at), TOTAL(applied), SUM(status = \'ok\') FROM track_grid'),
    one('SELECT COUNT(*), MAX(measured_at), SUM(status = \'ok\') FROM track_structure'),
    showsKey,
  ].join('|');
}

interface Snapshot { value: TransitionReadiness; key: string; showsKey: string; token: string; at: number }
let snap: Snapshot | null = null;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  // Never in the asking request's turn.
  await yieldTurn();
  const now = Date.now();
  const token = db.changeToken();
  const showsKey = showsKeyOf(hotMixShows());
  const key = inputsKey(showsKey);
  if (snap && snap.key === key && now - Date.parse(snap.value.computedAt) < SLOW_TTL_MS) {
    snap = { ...snap, token, at: now };
    return;
  }
  const value = await countTransitionReadiness(now);
  console.log(`[transition-readiness] counted ${value.library} tracks in ${value.durationMs} ms`);
  snap = { value, key, showsKey, token, at: now };
}

/** Start (or join) a background refresh. */
export function refreshTransitionReadiness(): Promise<void> {
  if (!db.getDb()) return Promise.resolve();
  if (!inflight) {
    inflight = refresh()
      .catch((err) => { console.warn(`[transition-readiness] refresh failed: ${(err as Error)?.message || err}`); })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * The last snapshot, at once; null before the first lands. Asks for a
 * background refresh when it may be stale (header); never counts here.
 */
export function getTransitionReadiness(now = Date.now()): TransitionReadiness | null {
  if (!db.getDb()) return snap?.value ?? null;
  try {
    const stale = !snap
      || (snap.token !== db.changeToken() && now - snap.at >= MIN_RECOUNT_MS)
      || now - snap.at >= SLOW_TTL_MS
      || snap.showsKey !== showsKeyOf(hotMixShows());
    if (stale) void refreshTransitionReadiness();
  } catch (err) {
    console.warn(`[transition-readiness] ${(err as Error)?.message || err}`);
  }
  return snap?.value ?? null;
}

/** Test hooks. */
export function _settled(): Promise<void> {
  return inflight ?? Promise.resolve();
}
export function _passes(): number {
  return passes;
}
export function _reset(): void {
  snap = null;
  passes = 0;
}
