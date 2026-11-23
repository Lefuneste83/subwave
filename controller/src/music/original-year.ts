// The year facet's runner: ask MusicBrainz for each track's original year and
// record the outcome (library-db recordOriginalYearOutcome). Shared by the
// tagger's enrichment phase, Reconcile and `npm run analyze -- --facets year`.
// The rules (what an answer means, when a failed lookup is retried) are in
// music/original-year-policy.ts; which tracks are due is the year facet row
// (library-db/facets.ts yearLookupDueIds).

import * as runlog from './run-log.js';
import * as subsonic from './subsonic.js';
import * as musicbrainz from './musicbrainz.js';
import * as discogs from './discogs.js';
import type { OriginalYearOutcome } from './original-year-policy.js';
import * as db from './library-db.js';
import { reportProgress } from './tagger-progress.js';
import { mapPool } from '../util/async-pool.js';

// MusicBrainz first; Discogs only when MusicBrainz answered that it has no year
// and a token is set. A MusicBrainz error is the outcome as it stands: Discogs
// is not asked, because its year would be kept for good (KEPT_YEAR_SOURCES) and
// one MusicBrainz blip would then lock in the rougher answer where the retry
// schedule would have reached MusicBrainz again. An unanswered Discogs is never
// read as a miss either: after a MusicBrainz miss it makes the result an error.
export async function lookupOriginalYearAnySource(track: {
  title?: string | null;
  artist?: string | null;
  mbid?: string | null;
  year?: number | null;
}): Promise<OriginalYearOutcome> {
  const mb = await musicbrainz.lookupOriginalYear(track);
  if (mb.kind !== 'not-found') return { ...mb, source: 'musicbrainz' };
  const dg = await discogs.lookupDiscogsYear(track);
  // A Discogs that took no part (no token, a refused one) leaves MusicBrainz's miss.
  return dg.kind === 'not-found' && !dg.source ? { kind: 'not-found', source: 'musicbrainz' } : dg;
}

export interface YearPassStats {
  asked: number;
  found: number;
  // Of `found`, the years only Discogs knew.
  discogs: number;
  notFound: number;
  errors: number;
}

// Effectively serial whatever the pool width: MusicBrainz throttles to 1 req/s
// (musicbrainz.ts). `force` re-asks a track already answered "not found" (an
// explicit `--where unmeasurable` / `--where all` run, or a `--re-enrich` miss
// inside the run's scope); a resolved or manual year is never re-asked.
export async function runYearLookups(
  ids: readonly string[],
  opts: { force?: boolean; concurrency?: number } = {},
): Promise<YearPassStats> {
  const stats: YearPassStats = { asked: 0, found: 0, discogs: 0, notFound: 0, errors: 0 };
  if (!ids.length) return stats;
  runlog.debug(`original years: ${ids.length} era-suspect tracks to resolve via ${yearSources()} (~1/s)`);
  reportProgress({ phase: 'enrich', label: 'Resolving original years', done: 0, total: ids.length });
  await mapPool([...ids], Math.max(1, Math.min(opts.concurrency ?? 4, 4)), async (id) => {
    const t = db.getTrack(id);
    if (!t || !musicbrainz.needsOriginalYearLookup(t, opts.force === true)) return;
    let mbid: string | null = null;
    try {
      mbid = (await subsonic.getSong(id))?.musicBrainzId || null;
    } catch { /* MBID is optional — the search path covers it */ }
    const outcome = await lookupOriginalYearAnySource({ title: t.title, artist: t.artist, mbid, year: t.year });
    db.recordOriginalYearOutcome(id, outcome);
    stats.asked += 1;
    if (outcome.kind === 'found') {
      stats.found += 1;
      if (outcome.source === 'discogs') stats.discogs += 1;
    }
    else if (outcome.kind === 'not-found') stats.notFound += 1;
    else stats.errors += 1;
    if (stats.asked % 25 === 0) {
      runlog.progress(stats.asked, ids.length);
      reportProgress({ phase: 'enrich', label: 'Resolving original years', done: stats.asked, total: ids.length });
    }
  });
  return stats;
}

// Where the lookups go, for the step's "Runs on" line.
export function yearSources(): string {
  return discogs.discogsToken() && !discogs.discogsRefused() ? 'MusicBrainz, then Discogs' : 'MusicBrainz';
}
