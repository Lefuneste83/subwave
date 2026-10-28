// Files Navidrome re-imported since the last walk, from its own REST API (the
// Subsonic API reports no change time: a repaired file that kept its exact
// size looks unchanged there). Used by the walk (tag-library/flags.ts) to find
// tracks whose file was replaced after SUB/WAVE measured them; the decision is
// replaced-file-policy.changedAfterMeasure.
//
// Navidrome-only and best-effort, like navidrome-players.ts: another server, a
// refused login or a timeout returns null and the walk carries on with the
// size check alone. Nothing here throws or holds up the walk.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { login, nativeFetch } from './navidrome-players.js';
import { serverKind } from './navidrome-players-policy.js';
import { pingWith } from './subsonic.js';
import { changesFloor } from './replaced-file-policy.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const PAGE = 1000;
// Bounds a runaway answer, not a real library: the walk stops at its floor.
const MAX_PAGES = 500;

export interface FileChange { id: string; updatedAt: string }

const markPath = () => path.join(config.stateDir, 'navidrome-file-changes.json');

async function readMark(): Promise<string | null> {
  try {
    const j = JSON.parse(await readFile(markPath(), 'utf8')) as { newest?: unknown };
    return typeof j.newest === 'string' ? j.newest : null;
  } catch { return null; }
}

/** Persist the newest change time this walk saw, once the walk has acted on it. */
export async function saveMark(newest: string | null): Promise<void> {
  if (!newest) return;
  await writeFileAtomic(markPath(), JSON.stringify({ newest, at: new Date().toISOString() }) + '\n').catch(() => {});
}

/**
 * Songs Navidrome updated since the stored mark, newest first, with the newest
 * time seen. The first walk (no mark) stops at the oldest measurement SUB/WAVE
 * holds: a file changed before it cannot postdate any track's measure, and
 * `updatedAt` is the file's own date, decades back on an old library.
 * `complete` is false when a page failed part-way (Navidrome 0.5x answers 500,
 * "ambiguous column name", past ~51k rows of this sort): the changes read so
 * far are the newest and still acted on, but the mark is not moved past them.
 * Null when the server is not Navidrome or its API is unavailable.
 */
export async function changedFiles(
  earliestMeasured: string | null,
): Promise<{ changes: FileChange[]; newest: string | null; complete: boolean } | null> {
  if (!config.navidrome.url || !config.navidrome.user || !config.navidrome.password) return null;
  try {
    const ping = await pingWith({ url: config.navidrome.url, user: config.navidrome.user, pass: config.navidrome.password });
    if (ping.ok && serverKind(ping.serverType) === 'other') return null;
    const token = await login();
    const mark = await readMark();
    const firstFloor = earliestMeasured ? Date.parse(earliestMeasured) : NaN;
    const floor = changesFloor(mark) ?? (Number.isFinite(firstFloor) ? firstFloor : null);
    // Nothing measured yet: nothing can be stale.
    if (floor == null) return { changes: [], newest: mark, complete: true };
    const changes: FileChange[] = [];
    let complete = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      let rows: Array<{ id?: unknown; updatedAt?: unknown }> | null;
      try {
        const res = await nativeFetch(
          `/api/song?_start=${page * PAGE}&_end=${(page + 1) * PAGE}&_sort=updated_at&_order=DESC`, { token });
        rows = (await res.json().catch(() => null)) as typeof rows;
      } catch {
        rows = null;
      }
      if (!Array.isArray(rows)) {
        if (page === 0) return null;
        complete = false;
        break;
      }
      let older = false;
      for (const r of rows) {
        if (typeof r.id !== 'string' || typeof r.updatedAt !== 'string') continue;
        if (Date.parse(r.updatedAt) < floor) { older = true; break; }
        changes.push({ id: r.id, updatedAt: r.updatedAt });
      }
      if (older || rows.length < PAGE) break;
    }
    return { changes, newest: changes[0]?.updatedAt ?? mark, complete };
  } catch {
    return null;
  }
}
