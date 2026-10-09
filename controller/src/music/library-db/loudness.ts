// Whole-file loudness (B13): the scope, the write and the failure stamp of the
// pass that replaces the analysis window's loudness/peak with a measurement
// over the whole file. The column meanings live with WHOLE_FILE_LOUDNESS_VERSION
// in handle.ts; the measurement itself in analyze_worker.py.

import { MAX_LOUDNESS_ATTEMPTS, WHOLE_FILE_LOUDNESS_VERSION, requireDb } from './handle.js';

const NEEDS_WHOLE_FILE = `(COALESCE(loudness_version, 0) < ${WHOLE_FILE_LOUDNESS_VERSION}
  AND COALESCE(loudness_attempts, 0) < ${MAX_LOUDNESS_ATTEMPTS})`;

// Tracks still on the window's figures (or never measured), minus the ones that
// failed MAX_LOUDNESS_ATTEMPTS passes in a row. RISK FIRST: the quietest window
// readings are the ones boosted hardest today, so they go first and a partial
// re-measure already removes most of the overs; never-measured tracks next
// (they play at unity until measured), then the rest. id breaks ties so a
// resumed pass picks up where the last one stopped.
export function needsWholeFileLoudnessIds(limit?: number): string[] {
  const sql =
    `SELECT id FROM tracks WHERE ${NEEDS_WHOLE_FILE}
       ORDER BY (loudness_lufs IS NULL), loudness_lufs ASC, id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  return (requireDb().prepare(sql).all() as Array<{ id: string }>).map(r => r.id);
}

// How many tracks the pass still has to measure, and how many it gave up on.
export function wholeFileLoudnessCounts(): { pending: number; done: number; givenUp: number } {
  const row = requireDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN ${NEEDS_WHOLE_FILE} THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN COALESCE(loudness_version, 0) >= ${WHOLE_FILE_LOUDNESS_VERSION} THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN COALESCE(loudness_version, 0) < ${WHOLE_FILE_LOUDNESS_VERSION}
                   AND COALESCE(loudness_attempts, 0) >= ${MAX_LOUDNESS_ATTEMPTS} THEN 1 ELSE 0 END) AS givenUp
       FROM tracks`,
    )
    .get() as { pending: number | null; done: number | null; givenUp: number | null };
  return { pending: row.pending ?? 0, done: row.done ?? 0, givenUp: row.givenUp ?? 0 };
}

// Loudness and peak are ONE measurement: written together, from the same pass,
// or not at all. Both null is a measured digital silence (no gain), which still
// stamps the version so the track leaves the scope. A lone figure is refused:
// a loudness without its peak would let a boost through with no ceiling.
export function recordWholeFileLoudness(id: string, m: { loudnessLufs: number | null; truePeakDb: number | null }): void {
  const lufs = Number.isFinite(m.loudnessLufs as number) ? (m.loudnessLufs as number) : null;
  const peak = Number.isFinite(m.truePeakDb as number) ? (m.truePeakDb as number) : null;
  if ((lufs === null) !== (peak === null)) {
    throw new Error('whole-file loudness needs both loudness and true peak, or neither');
  }
  requireDb()
    .prepare(
      `UPDATE tracks SET loudness_lufs = ?, peak_db = ?, loudness_version = ?, loudness_attempts = NULL
       WHERE id = ?`,
    )
    .run(lufs, peak, WHOLE_FILE_LOUDNESS_VERSION, id);
}

// A failed pass (unreadable file, ffmpeg error, timeout). The window's figures
// stay in place, so the track keeps playing exactly as before.
export function recordWholeFileLoudnessFailure(id: string): void {
  requireDb()
    .prepare(`UPDATE tracks SET loudness_attempts = COALESCE(loudness_attempts, 0) + 1 WHERE id = ?`)
    .run(id);
}

// Give every track another chance (operator action / tests): attempts only,
// measurements are kept.
export function clearWholeFileLoudnessFailures(): number {
  return requireDb().prepare(`UPDATE tracks SET loudness_attempts = NULL WHERE loudness_attempts IS NOT NULL`).run().changes;
}
