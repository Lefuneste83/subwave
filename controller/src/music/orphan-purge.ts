// B10 — orphan-stem purge, IO layer.
//
// planOrphanPurge / planQuarantinePurge (orphan-purge-pure.ts) decide; this
// file performs the moves on the share and reports. Rules the IO must keep:
//
// - NEVER delete an orphan directly. Orphans MOVE into <root>/.orphan-quarantine
//   (a dot-directory, so scanDirs and the marker walk ignore it), and only a
//   quarantine past the grace period is deleted. The quarantine is a move on
//   the same filesystem, so it is atomic and costs no copy — the property
//   root-squashed NFS shares need.
// - A quarantine whose id is in the library again is RELEASED back (the live
//   slot is free: a quarantine is a move, so exactly one copy exists). If a
//   fresh analysis already took the slot the quarantine is superseded and
//   simply ages out — never merged over the new copy.
// - Quarantine age comes from an `.orphaned-at` sidecar written at move time
//   (rename rewrites mtime, and the stem-priority lesson is that cache mtimes
//   lie); the entry's own mtime is only the fallback for quarantines that lost
//   the sidecar.
// - Dirs touched in the last hour are left alone: the analyzer writes stems
//   into a fresh dir, and a purge must never eat an in-flight set.
// - An empty id set is REFUSED, not treated as an empty library. The only
//   cheap way to get zero ids is a closed or half-open database, and quarantining
//   a whole cache on that reading is exactly the mass deletion quarantine exists
//   to survive.
// - Delete failures are counted and reported, never thrown — a purge that
//   cannot delete on a squashed share must keep running and keep saying so.
// - Any mutation drops the usage snapshot (stem-cache's cached walk totals),
//   so the next sweep re-measures instead of trusting stale bytes.

import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as stemCache from './stem-cache.js';
import {
  planOrphanPurge,
  planQuarantinePurge,
  QUARANTINE_DIR,
  type QuarantineEntry,
} from './orphan-purge-pure.js';

/** Directories newer than this are treated as in-flight analyzer writes. */
export const IN_FLIGHT_MS = 3600_000;

/** Sidecar stamped into a quarantine entry at move time. */
const ORPHANED_AT = '.orphaned-at';

export interface PurgeReport {
  dryRun: boolean;
  /** Cache dirs whose track is still in the library. */
  keptCount: number;
  /** Orphans moved into the quarantine (dry run: would move). */
  quarantined: number;
  quarantinedNames: string[];
  /** Quarantine entries moved back to the live cache. */
  released: string[];
  /** Quarantine entries deleted (dry run: would delete). */
  deletedCount: number;
  deletedNames: string[];
  /** Quarantine entries inside the grace period. */
  agingCount: number;
  /** Quarantines whose id is back in the library while the live slot is taken. */
  supersededCount: number;
  /** Cache dirs skipped as in-flight (written within IN_FLIGHT_MS). */
  inFlight: number;
  /** Moves/deletes that failed this pass (permissions, squashed roots). */
  failed: number;
  /** True when the pass refused to run; `reason` says why. */
  refused?: boolean;
  reason?: string;
  /** Bytes freed by deleted quarantines (quarantining itself frees nothing). */
  freedBytes: number;
  offline?: string;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { total += await dirBytes(path.join(dir, e.name)); continue; }
      try { total += (await stat(path.join(dir, e.name))).size; } catch { /* vanished mid-scan */ }
    }
  } catch { /* vanished mid-scan */ }
  return total;
}

// Quarantine age: the sidecar written at move time, else the entry's mtime.
async function quarantinedAgeMs(entryDir: string, now: number): Promise<number> {
  try {
    const stamped = Number(await readFileSafe(path.join(entryDir, ORPHANED_AT)));
    if (Number.isFinite(stamped) && stamped > 0) return Math.max(0, now - stamped);
  } catch { /* fall through */ }
  try {
    return Math.max(0, now - (await stat(entryDir)).mtimeMs);
  } catch {
    return 0;
  }
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return []; // no quarantine yet
  }
}

/**
 * One purge pass. `knownIds` is the library's full id set — the caller reads
 * it from the library DB; tests inject it. Unconfirmed is a pure dry run:
 * every branch of the plan is computed, nothing on disk is touched.
 */
export async function runOrphanPurge(opts: {
  knownIds: readonly string[];
  confirm: boolean;
  now?: number;
  inFlightMs?: number;
  quarantineDir?: string;
  graceMs?: number;
}): Promise<PurgeReport> {
  const now = opts.now ?? Date.now();
  const empty: PurgeReport = {
    dryRun: !opts.confirm, keptCount: 0, quarantined: 0, quarantinedNames: [], released: [],
    deletedCount: 0, deletedNames: [], agingCount: 0, supersededCount: 0, inFlight: 0, failed: 0,
    freedBytes: 0,
  };
  const rootStatus = await stemCache.stemsRootStatus({ readOnly: true });
  const root = stemCache.stemsRoot();
  const qu = opts.quarantineDir ?? path.join(root, QUARANTINE_DIR);
  const quExists = await stat(qu).then(st => st.isDirectory(), () => false);
  if (!rootStatus.online) {
    // "Offline" normally means an unmounted share, and then the purge must do
    // nothing. But a quarantine that is visible proves the share IS mounted
    // (a marker can be lost while entries age): in that reading only the aged
    // delete runs — quarantining NEW dirs into a share we cannot vouch for is
    // the step that stays refused.
    if (!quExists) return { ...empty, refused: true, reason: 'offline', offline: rootStatus.message };
  }

  if (opts.knownIds.length === 0) {
    return { ...empty, refused: true, reason: 'empty library id set: refusing (a closed or half-loaded database must never quarantine the cache)' };
  }
  const known = new Set(opts.knownIds);
  const inFlightMs = opts.inFlightMs ?? IN_FLIGHT_MS;
  const report: PurgeReport = { ...empty };

  // ---- cache-root walk: quarantine orphans --------------------------------
  let entries: string[] = [];
  if (rootStatus.online) {
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch {
      return { ...report, refused: true, reason: `cache root ${root} could not be read` };
    }
  }
  const cacheEntries: Array<{ name: string; known: boolean }> = [];
  for (const name of entries) {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path.join(root, name))).mtimeMs;
    } catch { continue; /* vanished mid-walk */ }
    if (!known.has(name) && now - mtimeMs < inFlightMs) { report.inFlight += 1; continue; }
    cacheEntries.push({ name, known: known.has(name) });
  }
  const plan = planOrphanPurge(cacheEntries, { now, confirm: opts.confirm });
  report.keptCount = plan.keptCount;
  report.quarantinedNames = plan.quarantine.map(q => q.name).slice(0, 10);

  // ---- quarantine walk -----------------------------------------------------
  const quEntries: QuarantineEntry[] = [];
  const quNames = await listDirs(qu);
  for (const name of quNames) {
    const entryDir = path.join(qu, name);
    const liveSlotFree = !(await stat(path.join(root, name)).then(() => true, () => false));
    quEntries.push({ name, known: known.has(name), ageMs: await quarantinedAgeMs(entryDir, now), liveSlotFree });
  }
  const qplan = planQuarantinePurge(quEntries, { now, confirm: opts.confirm, ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}) });
  report.released = qplan.released;
  report.deletedNames = qplan.deleted.map(d => d.name).slice(0, 10);
  report.agingCount = qplan.aging.length;
  report.supersededCount = qplan.superseded.length;

  if (opts.confirm) {
    // 1. Releases first: an id that is both known now and sitting in the
    //    quarantine gets its copy back rather than being re-quarantined below.
    for (const name of qplan.released) {
      try {
        await rename(path.join(qu, name), path.join(root, name));
      } catch { report.failed += 1; }
    }
    // 2. Aged (and superseded-with-fresh-copy) quarantines: delete for good.
    for (const { name } of qplan.deleted) {
      const entryDir = path.join(qu, name);
      try {
        report.freedBytes += await dirBytes(entryDir);
        await rm(entryDir, { recursive: true, force: true });
        report.deletedCount += 1;
      } catch { report.failed += 1; }
    }
    // 3. Orphans: move into quarantine (same-filesystem rename; no merge).
    await mkdirSafe(qu);
    for (const { name } of plan.quarantine) {
      const from = path.join(root, name);
      const to = path.join(qu, name);
      const collision = await stat(to).then(() => true, () => false);
      if (collision) {
        // A quarantine entry for the same id already exists — it can only have
        // been re-created in the library and orphaned again. Keep the OLDER
        // quarantine (it is closer to its real age), drop the newer copy.
        const existingAge = await quarantinedAgeMs(to, now);
        const freshAge = await quarantinedAgeMs(from, now);
        try {
          if (existingAge >= freshAge) { await rm(from, { recursive: true, force: true }); }
          else { await rm(to, { recursive: true, force: true }); await rename(from, to); await stampQuarantine(to, now); }
          report.quarantined += 1;
        } catch { report.failed += 1; }
        continue;
      }
      try {
        await rename(from, to);
        await stampQuarantine(to, now);
        report.quarantined += 1;
      } catch { report.failed += 1; }
    }
    if (report.quarantined || report.deletedCount || report.released.length) {
      // The usage snapshot cached the pre-purge totals; drop it so the next
      // sweep walks again instead of trusting bytes that no longer exist.
      await rm(path.join(config.stateDir, 'stem-cache-usage.json'), { force: true }).catch(() => {});
    }
  } else {
    // Dry run: every count, zero mutations.
    report.quarantined = plan.quarantine.length;
    report.deletedCount = qplan.deleted.length;
  }
  return report;
}

async function stampQuarantine(entryDir: string, now: number): Promise<void> {
  try {
    await writeFile(path.join(entryDir, ORPHANED_AT), String(now));
  } catch { /* the mtime fallback covers it */ }
}

async function mkdirSafe(dir: string): Promise<void> {
  try { await (await import('node:fs/promises')).mkdir(dir, { recursive: true, mode: 0o777 }); } catch { /* reported by the move failures */ }
}

/** Dry-run convenience for the doctor and the admin route. */
export async function orphanPurgeReport(knownIds: readonly string[]): Promise<PurgeReport> {
  return runOrphanPurge({ knownIds, confirm: false });
}
