// The structure facet's read-only report (`npm run structure-report`): per
// track, the hard-kick points the rules in music/structure-policy.ts read off
// the stored bars (library-db/structure.ts), so a run can be compared with the
// offline prototype the operator validated by ear before any transition reads
// them. Reads only: tracks, track_facet_status, track_structure.

import * as db from './library-db.js';
import { barStartMs, structurePoints, type StructurePoints } from './structure-policy.js';

export interface StructureReportRow extends StructurePoints {
  id: string;
  title: string;
  artist: string;
  // The facet row's status ('missing' = none: never measured, or no grid).
  status: 'ok' | 'unmeasurable' | 'failed' | 'missing';
  reason: string | null;
  version: number | null;
  // Where the first hard kick's bar starts and the last one's bar ends, ms.
  firstHardKickMs: number | null;
  lastHardKickEndMs: number | null;
}

const empty: StructurePoints = { bars: 0, fullSectionStart: null, firstHardKick: null, lastHardKick: null, introBars: null, outroBars: null };

// One row per known id (unknown ids are left out); no ids = every track with a
// measured structure.
export function structureReport(ids?: readonly string[]): StructureReportRow[] {
  const scope = ids ?? db.measuredStructureIds();
  const state = db.loadFacetState(['structure']);
  const rows: StructureReportRow[] = [];
  for (const id of scope) {
    const t = db.getTrack(id);
    if (!t) continue;
    const cell = state.get(id)?.get('structure');
    const s = db.getStructure(id);
    const points = s?.status === 'ok' && s.bars ? structurePoints(s.bars) : empty;
    const runs = s?.bars?.runs ?? [];
    const lastEnd = points.lastHardKick != null ? endOfBar(runs, points.lastHardKick) : null;
    rows.push({
      id, title: t.title ?? '', artist: t.artist ?? '',
      status: cell?.status ?? 'missing', reason: cell?.reason ?? null, version: cell?.version ?? null,
      ...points,
      firstHardKickMs: points.firstHardKick != null ? barStartMs(runs, points.firstHardKick) : null,
      lastHardKickEndMs: lastEnd,
    });
  }
  return rows;
}

// Where bar `bar` (1-based) ends, ms.
function endOfBar(runs: ReadonlyArray<readonly [number, number, number]>, bar: number): number | null {
  let i = bar - 1;
  for (const [start, barUs, count] of runs) {
    if (i < count) return start + ((i + 1) * barUs) / 1000;
    i -= count;
  }
  return null;
}

const sec = (ms: number | null) => (ms == null ? '-' : (ms / 1000).toFixed(1));
const n = (v: number | null) => (v == null ? '-' : String(v));

export function formatStructureReport(rows: readonly StructureReportRow[]): string[] {
  const out = [
    'id                      bars  full  first(s)        last(end s)     intro outro  status            title',
  ];
  for (const r of rows) {
    const status = r.status === 'ok' && r.reason == null ? 'ok' : `${r.status}${r.reason ? `:${r.reason}` : ''}`;
    out.push([
      r.id.padEnd(22).slice(0, 22),
      n(r.bars).padStart(5),
      n(r.fullSectionStart).padStart(5),
      `${n(r.firstHardKick)} (${sec(r.firstHardKickMs)})`.padStart(15),
      `${n(r.lastHardKick)} (${sec(r.lastHardKickEndMs)})`.padStart(15),
      n(r.introBars).padStart(5),
      n(r.outroBars).padStart(5),
      ' ' + status.padEnd(17).slice(0, 17),
      `${r.artist ? `${r.artist} — ` : ''}${r.title}`,
    ].join(' '));
  }
  const ok = rows.filter((r) => r.firstHardKick != null).length;
  out.push('', `${rows.length} tracks, ${ok} with a full section found (bars are 1-based; first = the first hard kick, last = the last one)`);
  return out;
}
