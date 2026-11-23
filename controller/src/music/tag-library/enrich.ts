// Phase 0 - enrichment: Last.fm tags (artist-level, plus the opt-in track-level
// lookups), lyric excerpts, and MusicBrainz original-year resolution for
// compilation tracks. See ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as lastfm from '../lastfm.js';
import { runYearLookups, yearSources, type YearPassStats } from '../original-year.js';
import * as db from '../library-db.js';
import * as settings from '../../settings.js';
import { createLastfmPacer, type LastfmPacer } from '../lastfm-pacer.js';
import { selectTrackTagIds } from '../enrich-scope.js';
import { listAfterArtistLookup } from '../lastfm-tag-policy.js';
import { reportProgress } from '../tagger-progress.js';
import { mapPool, memoizeByKey } from '../../util/async-pool.js';
import * as runlog from '../run-log.js';
import * as F from '../run-log-format.js';
import { LASTFM_WHERE, navidromeWhere } from '../run-log-where.js';

// What the enrich step fetches this run, by the operator's switches: its
// title in the run's banner.
export function enrichSwitches(): { lastfm: boolean; lyrics: boolean; years: boolean } {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  return {
    lastfm: lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, lastfm.hasLastfmKey()),
    lyrics: enrichCfg.lyrics !== false,
    years: enrichCfg.originalYear !== false,
  };
}

export async function phaseEnrich(
  ids: string[],
  reEnrich: boolean,
  limit: number = Infinity,
  step: runlog.Step = runlog.step('enrich', 'Fetch track details'),
): Promise<void> {
  const enrichCfg = (settings.get() as any).embedding?.enrichment ?? {};
  // With a Last.fm api_key we hit the API directly (it returns tags); the
  // tri-state gate keeps keyless installs off the tag-less getArtistInfo2 path.
  const hasKey = lastfm.hasLastfmKey();
  const lastfmEnabled = lastfm.lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
  const trackTagsOn = lastfm.lastfmTrackTagsEnabled(enrichCfg, hasKey);
  const lyricsEnabled = enrichCfg.lyrics !== false;
  // Scoped in SQL, not by the tagger's untagged/enriched id set: gating on the
  // enrich scope would never backfill an already-tagged library.
  const yearIds = pendingOriginalYearIds(reEnrich, ids);
  const trackTagIds = trackTagsOn
    ? selectTrackTagIds({ reEnrich, limit, ids, owed: db.idsNeedingLastfmTrackTags() })
    : [];
  if (ids.length === 0 && yearIds.length === 0 && trackTagIds.length === 0) {
    step.skip('nothing to fetch');
    return;
  }
  if (!lastfmEnabled && !lyricsEnabled && yearIds.length === 0) {
    step.skip('Last.fm tags and lyrics are off, and no original year is due');
    return;
  }
  // Skip the loop when both are disabled: running it would stamp enrichedAt on
  // empty rows and mask a later re-enable.
  const metaIds = lastfmEnabled || lyricsEnabled ? ids : [];
  const runsOn = [
    lastfmEnabled ? (hasKey ? LASTFM_WHERE : `${navidromeWhere()} (artist info)`) : '',
    lyricsEnabled && metaIds.length ? `${navidromeWhere()} (lyrics)` : '',
    yearIds.length ? `${yearSources()} (original years)` : '',
  ].filter(Boolean);
  step.start({
    runsOn: runsOn.join(' · '),
    scope: F.enrichScope({ tracks: metaIds.length, trackTags: trackTagIds.length, years: yearIds.length, pool: db.trackCount() }),
  });
  if (lastfmEnabled && !hasKey) {
    step.note('No Last.fm API key: artist tags come through the music server, which usually has none. Add a key in Settings → Library tagger.');
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

  // I/O-bound, so drain with a bounded pool. DB writes are synchronous
  // (better-sqlite3) and so serialise on the event loop without locking.
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(process.env.TAG_ENRICH_CONCURRENCY || '', 10) || 6),
  );

  await mapPool(metaIds, concurrency, async (id) => {
    const t = db.getTrack(id);
    if (!t) return;
    if (!reEnrich && t.enrichedAt) return;

    // The track pass below owns a stored list on this path. It must find the row
    // as it stands: an artist-only rewrite here would read as a change to every
    // row it re-merged, and an outage would lose the merged list. A row with no
    // list still gets the artist's, as it would with track tags off. The pass can
    // end short of it, this write marks it enriched so no later run fills it, and
    // a never-play rule on the act would miss it. The pass adds to what it finds.
    // With track tags off the artist is asked every time the row is visited, and only tags replace
    // the list (listAfterArtistLookup, Retag's rule too): an outage, an empty
    // answer or Last.fm tags off leave it as it was (#2295).
    let lastfmTags: string[] | null = t.lastfmTags;
    let fetchedTags = false;
    if (lastfmEnabled && t.artist && (!trackTagsOn || !lastfmTags?.length)) {
      const tags = await artistTags(t.artist);
      fetchedTags = tags.length > 0;
      lastfmTags = listAfterArtistLookup(lastfmTags, tags);
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
    if (!trackTagsOn && fetchedTags) enrichedTags += 1;
    if (lyricExcerpt) enrichedLyrics += 1;
    if (enrichedTracks % 100 === 0) {
      step.progress(enrichedTracks, metaIds.length);
      reportProgress({ phase: 'enrich', label: 'Enriching metadata', done: enrichedTracks, total: metaIds.length });
    }
  });

  enrichedTags += await backfillLastfmTrackTags(trackTagIds, concurrency);
  const years = await backfillOriginalYears(yearIds, reEnrich, concurrency);

  step.done({
    summary: F.enrichSummary({
      tracks: enrichedTracks, tags: enrichedTags, lyrics: enrichedLyrics,
      years: years.found, yearsAsked: years.asked, yearErrors: years.errors,
    }),
  });
}

// Track-level Last.fm tags, opt-in (embedding.enrichment.lastfmTrackTags). One
// call per song, so unlike the memoised artist call this is a pass of its own:
// paced across the pool (lastfm-pacer.ts) and resumable. Every row it answers is
// stamped, hit or miss, and a failure stamps nothing, so a stopped or failed pass
// picks up where it left off (lastfm_track_tags_at). Runs over the whole of its
// scope rather than inside the loop above, since most of a backfill is rows that
// loop never sees. Returns the rows that ended up with a list.
export async function backfillLastfmTrackTags(
  ids: string[],
  concurrency: number,
  pacer: LastfmPacer = createLastfmPacer(),
): Promise<number> {
  if (!ids.length) return 0;
  runlog.debug(`track tags: ${ids.length} tracks to look up via Last.fm (~4/s)`);
  reportProgress({ phase: 'enrich', label: 'Fetching track tags', done: 0, total: ids.length });
  const source = lastfm.pacedTagSource(pacer);
  let checked = 0;
  let answered = 0;
  let ownTags = 0;
  let listed = 0;
  let unaskable = 0;
  await mapPool(ids, Math.min(concurrency, 4), async (id) => {
    if (pacer.gaveUp) return;
    const t = db.getTrack(id);
    if (!t?.artist || !t.title) {
      unaskable += 1;
      return;
    }
    const merged = await lastfm.getMergedTags(t.artist, t.title, { count: 10, source });
    const stored = db.recordLastfmTrackTags(id, merged);
    checked += 1;
    if (merged.answered) answered += 1;
    if (merged.answered && merged.trackTagCount > 0) ownTags += 1;
    if (stored) listed += 1;
    if (checked % 100 === 0) {
      runlog.progress(checked, ids.length);
      reportProgress({ phase: 'enrich', label: 'Fetching track tags', done: checked, total: ids.length });
    }
  });
  const left = ids.length - answered - unaskable;
  const said = `Last.fm track tags: ${F.fmtCount(answered)} tracks answered, ${F.fmtCount(ownTags)} with tags of their own`;
  if (pacer.gaveUp) runlog.problem('warning', `${said}. Last.fm stopped answering, so ${F.fmtCount(left)} are left for the next run.`);
  else runlog.note(`${said}${left > 0 ? `, ${F.fmtCount(left)} left for the next run` : ''}`);
  return listed;
}

// Ids owed a MusicBrainz original-year lookup (#842). Keyless, so default-on;
// [] when settings.embedding.enrichment.originalYear is false.
//
// Always the year facet's due set: tracks never asked, and failed lookups past
// their retry delay (original-year-policy.ts), library-wide. An answered "not
// found" is settled and is re-asked only by `--facets year --where
// unmeasurable` — or, with `retryMisses` (--re-enrich), for the misses inside
// `scope`, the run's own tracks. With --limit that is a bounded set; without
// it the run's scope is the whole library, and so are its misses.
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
): Promise<YearPassStats> {
  return runYearLookups(yearIds, { force: retryMisses, concurrency });
}
