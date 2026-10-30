// When a library file counts as replaced: the walk keeps a track's id when its
// file is replaced at the same path (Navidrome derives the id from the path),
// so one of these signals is the only way the new audio ever gets measured.
// Pure: scripts/replaced-file.test.ts. Callers: library-db.upsertTrackMeta (the
// size) and music/file-changes.ts (Navidrome's own change time).

// Any Subsonic server: the walked size differs from a known stored one. A
// stored NULL (a row walked before file facts existed) is not a change. Misses
// a repaired file that kept its exact size, which is what the change time is for.
export function fileReplaced(storedSize: number | null | undefined, walkedSize: number | null | undefined): boolean {
  return storedSize != null && storedSize > 0 && walkedSize != null && walkedSize > 0 && storedSize !== walkedSize;
}

// Navidrome: the server re-imported the file (its native `updatedAt`) after
// SUB/WAVE last measured the track (the newest analysis facet row). A track
// never measured has nothing stale to clear. A re-import also follows a
// tag-only edit, so such a track is re-analysed too: the accepted cost.
export function changedAfterMeasure(updatedAt: string | null | undefined, lastMeasuredAt: string | null | undefined): boolean {
  if (!updatedAt || !lastMeasuredAt) return false;
  const changed = Date.parse(updatedAt);
  const measured = Date.parse(lastMeasuredAt);
  return Number.isFinite(changed) && Number.isFinite(measured) && changed > measured;
}

// How far back each walk asks Navidrome for changes: from the newest change
// time the previous walk saw, less a margin for clock skew and a scan still
// writing while the previous walk read. No mark (the first walk): everything.
export const CHANGE_MARK_MARGIN_MS = 6 * 3_600_000;
export function changesFloor(mark: string | null | undefined): number | null {
  const t = mark ? Date.parse(mark) : NaN;
  return Number.isFinite(t) ? t - CHANGE_MARK_MARGIN_MS : null;
}
