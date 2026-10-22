// Phase 0 - enrichment: Last.fm tags, lyric excerpts, and MusicBrainz
// original-year resolution for compilation tracks. See ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as lastfm from '../lastfm.js';
import { runYearLookups } from '../original-year.js';
import * as db from '../library-db.js';
import * as settings from '../../settings.js';
import { reportProgress } from '../tagger-progress.js';
import { mapPool, memoizeByKey } from '../../util/async-pool.js';
import { logEvent } from './log.js';

export async function phaseEnrich(ids: string[], reEnrich: boolean): Promise<void> {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  // With a Last.fm api_key we hit the API directly (it returns tags); the
  // tri-state gate keeps keyless installs off the tag-less getArtistInfo2 path.
  const hasKey = lastfm.hasLastfmKey();
  const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
  const lyricsEnabled = enrichCfg.lyrics !== false;
  // Scoped in SQL, not by the tagger's untagged/enriched id set: gating on the
  // enrich scope would never backfill an already-tagged library.
  const yearIds = pendingOriginalYearIds(reEnrich, ids);
  if (ids.length === 0 && yearIds.length === 0) return;
  if (!lastfmEnabled && !lyricsEnabled && yearIds.length === 0) {
    console.log('[tag] phase-0 skipped: lastfmTags and lyrics disabled, no original-year lookups pending');
    return;
  }
  if (lastfmEnabled) {
    console.log(
      `[tag] phase-0 Last.fm tags via ${hasKey ? 'direct API (artist.getTopTags)' : 'Navidrome getArtistInfo2 (no api_key — likely empty)'}`,
    );
  }
  reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: 0, total: ids.length });
  // Memoize on the in-flight PROMISE, not the value, so the pool below shares one
  // API call per artist.
  const artistTags = memoizeByKey<string[]>(artist =>
    lastfm.getArtistTags(artist, { count: 10 }).then(t => t ?? []).catch(() => []),
  );

  let enrichedTracks = 0;
  let enrichedLyrics = 0;
  let enrichedTags = 0;
  let enrichedYears = 0;

  // I/O-bound, so drain with a bounded pool. DB writes are synchronous
  // (better-sqlite3) and so serialise on the event loop without locking.
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(process.env.TAG_ENRICH_CONCURRENCY || '', 10) || 6),
  );

  // Skip the loop when both are disabled: running it would stamp enrichedAt on
  // empty rows and mask a later re-enable.
  const metaIds = lastfmEnabled || lyricsEnabled ? ids : [];
  await mapPool(metaIds, concurrency, async (id) => {
    const t = db.getTrack(id);
    if (!t) return;
    if (!reEnrich && t.enrichedAt) return;

    let lastfmTags: string[] | null = null;
    if (lastfmEnabled && t.artist) {
      const tags = await artistTags(t.artist);
      lastfmTags = tags.length ? tags : null;
    }

    let lyricExcerpt: string | null = null;
    if (lyricsEnabled) {
      try {
        const raw = await subsonic.getLyrics(id);
        if (typeof raw === 'string' && raw.trim()) {
          lyricExcerpt = raw.trim();
        }
      } catch { /* ignore */ }
    }

    db.upsertTrackEnrichment(id, { lastfmTags, lyricExcerpt });
    enrichedTracks += 1;
    if (lastfmTags && lastfmTags.length) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      console.log(
        `[tag] enriched ${enrichedTracks}/${metaIds.length} (lastfm: ${enrichedTags}, lyrics: ${enrichedLyrics})`,
      );
      reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: enrichedTracks, total: metaIds.length });
    }
  });

  enrichedYears = await backfillOriginalYears(yearIds, reEnrich, concurrency);

  logEvent(
    'info',
    `Metadata fetched for ${enrichedTracks.toLocaleString('en-GB')} tracks ` +
      `(${enrichedTags} Last.fm, ${enrichedLyrics} lyrics, ${enrichedYears} original years)`,
  );
}

// Ids owed a MusicBrainz original-year lookup (#842). Keyless, so default-on;
// [] when settings.embedding.enrichment.originalYear is false.
//
// Always the year facet's due set: tracks never asked, and failed lookups past
// their retry delay (original-year-policy.ts), library-wide. An answered "not
// found" is settled and is re-asked only by `--facets year --where
// unmeasurable` — or, with `retryMisses` (--re-enrich), for the misses inside
// `scope`, the run's own tracks. Never every miss in the library.
export function pendingOriginalYearIds(retryMisses: boolean, scope: readonly string[] = []): string[] {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  if (enrichCfg.originalYear === false) return [];
  const due = db.yearLookupDueIds(Date.now());
  if (!retryMisses) return due;
  const inScope = new Set(scope);
  const seen = new Set(due);
  const misses = db.idsNeedingOriginalYear(true).filter(id => inScope.has(id) && !seen.has(id));
  return [...due, ...misses];
}

// Original-year backfill (#842) for era-suspect tracks whose `year` is the
// reissue's release date. Also run by --reconcile-only: that walk stamps
// era_untrusted and clears stale album-tag years, so it must answer the tracks
// it has just made suspect (#1418). `retryMisses` lets the run's own misses be
// asked again (see pendingOriginalYearIds). Returns the number resolved.
export async function backfillOriginalYears(
  yearIds: string[],
  retryMisses: boolean,
  concurrency: number,
): Promise<number> {
  const stats = await runYearLookups(yearIds, { force: retryMisses, concurrency });
  return stats.found;
}
