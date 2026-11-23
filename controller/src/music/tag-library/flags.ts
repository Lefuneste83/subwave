// CLI arg parsing and the pre-flight passes that run before any phase: walking
// Navidrome, reconciling deleted tracks, and folding the wizard's overlay in.
// See ../tag-library.ts for main().

import * as subsonic from '../subsonic.js';
import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import { adoptAndPrune } from '../id-rotation.js';
import { albumEraKey, applyWalkForcedYear, eraWalkFields, libraryOwnerContext, liveEraOverrides, type EraOverride, type EraOverrideLookup } from '../era-review.js';
import { loadSecretsIntoEnv } from '../../setup/secrets.js';
import { loadNavidromeConfig } from '../../setup/config.js';
import { reportProgress, reportCatalogueReady } from '../tagger-progress.js';
import * as runlog from '../run-log.js';
import * as F from '../run-log-format.js';
import { navidromeWhere } from '../run-log-where.js';
import { changedAfterMeasure, decideReplacedClear } from '../replaced-file-policy.js';
import { backfillOriginalYears, pendingOriginalYearIds } from './enrich.js';
import { yearSources } from '../original-year.js';
import * as settings from '../../settings.js';

function parseIntFlag(args: string[], name: string): number | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : null;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

interface CliFlags {
  limit: number;
  batchSize: number | null;
  seedCount: number | null;
  maxRounds: number | null;
  noPropagate: boolean;
  reseed: boolean;
  reEnrich: boolean;
  skipEnrich: boolean;
  upgrade: boolean;
  // With --upgrade: re-decide only the blind rows measured since (#2281,
  // db.blindTaggedIds), instead of the rows with a stale prompt or model.
  upgradeBlind: boolean;
  skipAnalyze: boolean;
  reAnalyze: boolean;
  reconcileOnly: boolean;
  // Skip embed + mood tagging (phases 1-4); walk, enrich and analyze still run
  // per their own flags.
  skipTag: boolean;
  // Walk Navidrome but don't prune orphaned rows (a normal run prunes).
  noPrune: boolean;
  // Confirms a prune music/prune-policy.ts would hold as a mass removal.
  confirmPrune: boolean;
  // Per-run override of the Phase 5 Demucs vocal-activity backfill. Neither
  // flag falls back to settings.audio.vocalActivity / ANALYZE_VOCAL_ACTIVITY.
  vocal: boolean;
  noVocal: boolean;
  // Re-scan mode: fire ONLY the selected re-* passes, each scoped to
  // already-done tracks, suppressing the forward seed→propagate→active-learn
  // discovery. Raw re-* flags without --rescan keep their full-library meaning.
  rescan: boolean;
}

export function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  // null = no --batch flag → fall back to settings.embedding.batchSize in main().
  const rawBatch = parseIntFlag(args, '--batch');
  return {
    limit: parseIntFlag(args, '--limit') ?? Infinity,
    batchSize: rawBatch !== null ? Math.max(1, Math.min(50, rawBatch)) : null,
    seedCount: parseIntFlag(args, '--seeds'),
    // null = fall back to settings.embedding.maxActiveLearningRounds
    maxRounds: parseIntFlag(args, '--max-rounds'),
    noPropagate: args.includes('--no-propagate'),
    reseed: args.includes('--reseed'),
    reEnrich: args.includes('--re-enrich'),
    skipEnrich: args.includes('--skip-enrich'),
    // Re-decide moods: re-LLM-tag rows whose prompt/model went stale.
    // db.staleTaggedIds excludes source='manual' — operator tags are ground
    // truth and never go stale.
    upgrade: args.includes('--upgrade'),
    upgradeBlind: args.includes('--upgrade-blind'),
    skipAnalyze: args.includes('--skip-analyze'),
    reAnalyze: args.includes('--re-analyze'),
    // Walk Navidrome, prune rows for tracks it no longer contains, then exit —
    // no embeddings, no LLM.
    reconcileOnly: args.includes('--reconcile-only'),
    skipTag: args.includes('--skip-tag'),
    noPrune: args.includes('--no-prune'),
    confirmPrune: args.includes('--confirm-prune'),
    vocal: args.includes('--vocal'),
    noVocal: args.includes('--no-vocal'),
    rescan: args.includes('--rescan'),
  };
}

// The file facts a Subsonic child carries, for the library status exports:
// `path` is the real file path only when the client has "Report Real Path" on in
// Navidrome (otherwise one built from the tags), `size` is bytes, `bitRate` kbps.
export function walkFileInfo(
  song: { path?: unknown; suffix?: unknown; size?: unknown; bitRate?: unknown } | null | undefined,
): db.FileInfo {
  return db.cleanFileInfo({
    filePath: song?.path, fileSuffix: song?.suffix, fileSize: song?.size, bitRate: song?.bitRate,
  });
}

// Walk the whole Navidrome catalogue, upserting each song's metadata and
// collecting the live id set. Shared by the full tagger run and
// --reconcile-only. No embeddings and no LLM, but more than metadata: a file
// replaced at the same path has its analysis cleared and its stems dropped here
// (replaced-file-policy.ts), unless that is held or the operator accepts it.
// `replacedHeld` counts the candidates a hold left waiting, 0 without one.
// Reports as the run's walk step (run-log.ts): its header here, its result
// line from the caller once the prune has run.
export async function walkNavidrome(
  {
    confirmReplaced = process.argv.includes('--confirm-replaced'),
    acceptReplaced = process.argv.includes('--accept-replaced'),
    step = runlog.step('walk', F.STEP_TITLE.walk),
  }: { confirmReplaced?: boolean; acceptReplaced?: boolean; step?: runlog.Step } = {},
): Promise<{ walked: number; liveIds: Set<string>; replacedHeld: number }> {
  step.start({ runsOn: navidromeWhere(), scope: F.walkScope(db.trackCount()) });
  reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
  let walked = 0;
  const liveIds = new Set<string>();
  // Blast radius of the era gate, reported once at the end so an operator sees
  // it in the log rather than as a show that stopped picking (#1418).
  const eraReasons = new Map<string, number>();
  // Operator era records, each album's read as the walk reaches it
  // (era-review.liveEraOverrides): a decision replaces the walk's stored
  // verdict for its album, a kind replaces the title's suggestion, and a
  // one-year decision reaches tracks added since. Never a snapshot from before
  // the run: a decision removed mid-run must not be written back.
  const rawDb = db.getDb();
  const eraOverrides: EraOverrideLookup = rawDb ? liveEraOverrides(rawDb) : new Map<string, EraOverride>();
  // The library as it stood before this walk (its artist credits, its sorting
  // folders), so a DJ's own compilation is never taken for a label's
  // (album-kind.labelOwner).
  const ownerCtx = rawDb ? libraryOwnerContext(rawDb, { fresh: true }) : undefined;
  // Files replaced at the same path (same id): candidates from both signals,
  // cleared together after the walk behind a mass hold. id -> the walked size
  // (the size signal) or null (the change-time signal).
  const candidates = new Map<string, number | null>();
  // One song's row, as the walk writes it.
  const writeSong = (song: any): void => {
    const eraFields = eraWalkFields(song, eraOverrides, ownerCtx);
    const fileInfo = walkFileInfo(song);
    const fileReplaced = db.upsertTrackMeta(song.id, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      // Subsonic ids. The walk is the only writer that has them, and they let
      // an ALBUM/ARTIST blocklist entry match by id rather than by name.
      albumId: song.albumId ?? null,
      artistId: song.artistId ?? null,
      albumArtistId: song.albumArtistId ?? null,
      year: song.year,
      // Album-level era signals (#842, #1418). The album's originalReleaseDate
      // is a track's original year only when informative, and never on an
      // album the detector or the operator holds suspect
      // (era-review.albumTagYear, through eraWalkFields).
      originalYear: eraFields.originalYear,
      isCompilation: song.albumIsCompilation ?? null,
      eraUntrusted: eraFields.eraUntrusted,
      // Why the walk flagged it (audit truth — never rewritten by an
      // override), and the album artist the override key folds on (C13).
      eraReason: eraFields.eraReason,
      albumKind: eraFields.albumKind,
      albumArtist: eraFields.albumArtist,
      genres: subsonic.songGenres(song),
      duration: song.duration,
      // Always a value: null is how a walk clears a tag that has gone, so a
      // server that omits the field reads as no tag rather than as no opinion.
      explicitStatus: db.normaliseExplicitStatus(song.explicitStatus),
      ...fileInfo,
    });
    if (fileReplaced) candidates.set(song.id, fileInfo.fileSize);
    // A one-year decision (Library → Era) on this album: a track that arrived
    // after it, or lost its year, gets it as its manual year. A track that
    // already holds a manual year keeps it (the operator set that one). A
    // track that left an album's one-year decision for an album without one
    // gets its own year back (#2319). After the upsert, so the row holds the
    // album this key names.
    applyWalkForcedYear(song.id, albumEraKey(eraFields.albumArtist, song.album), eraFields.forcedYear);
    liveIds.add(song.id);
    if (song.albumEraUntrusted && song.albumEraReason) {
      eraReasons.set(song.albumEraReason, (eraReasons.get(song.albumEraReason) ?? 0) + 1);
    }
  };
  // An album's rows are written in one transaction: the same statements in the
  // same order, without a commit per song (most of a 75k-track walk's time was
  // those commits and the statements around them). Synchronous, so the write
  // lock is never held across a Navidrome round trip.
  const writeAlbum = rawDb ? rawDb.transaction((songs: any[]) => { for (const s of songs) writeSong(s); })
    : (songs: any[]) => { for (const s of songs) writeSong(s); };
  for await (const album of subsonic.iterateAllAlbums({ requireComplete: true })) {
    writeAlbum(album.songs);
    for (const _ of album.songs) {
      walked += 1;
      if (walked % 500 === 0) {
        step.progressCount(walked, 'tracks read');
        reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: walked });
      }
    }
  }
  // A repaired file can keep its exact size: Navidrome's own change time
  // catches it (replaced-file-policy.changedAfterMeasure). Navidrome-only and
  // best-effort: null = the size check alone.
  // An empty walk (an outage that listed nothing) asks nothing more of the server.
  const fileChanges = walked === 0 ? null
    : await import('../file-changes.js').then(m => m.changedFiles(db.earliestMeasuredAt())).catch(() => null);
  const sizeCandidates = candidates.size;
  if (fileChanges) {
    for (const c of fileChanges.changes) {
      if (candidates.has(c.id) || !liveIds.has(c.id)) continue;
      if (!changedAfterMeasure(c.updatedAt, db.lastMeasuredAt(c.id))) continue;
      candidates.set(c.id, null);
    }
  }
  // The signal counts behind the one plain line said below (debug).
  if (fileChanges) {
    runlog.debug(F.replacedFilesDebug({
      read: fileChanges.changes.length, since: fileChanges.since ?? null,
      bySize: sizeCandidates, byTime: candidates.size - sizeCandidates,
    }));
  }
  const decision = decideReplacedClear({
    candidates: candidates.size, knownTracks: walked, confirmed: confirmReplaced, accepted: acceptReplaced,
  });
  const held = !decision.clear && decision.reason === 'held';
  if (held) runlog.problem('warning', decision.message, { hold: true });
  const replaced = decision.clear ? [...candidates.keys()] : [];
  for (const [id, size] of decision.clear ? candidates : []) db.clearTrackAudio(id, size);
  let stemsDropped: { removed: number; failed: number; offline?: string } | undefined;
  if (replaced.length > 0) {
    stemsDropped = await import('../stem-cache.js')
      .then(m => m.forgetStems(replaced))
      .catch((err: unknown) => ({ removed: 0, failed: replaced.length, offline: String((err as Error)?.message ?? err) }));
  }
  let accepted: { count: number; resent: number } | undefined;
  if (!decision.clear && decision.reason === 'accepted' && candidates.size > 0) {
    const resent = db.acceptReplacedFiles(candidates, new Map(fileChanges?.changes.map(c => [c.id, c.updatedAt])));
    accepted = { count: candidates.size, resent };
  }
  // One line per walk, whatever it found.
  step.note(F.replacedFilesLine({
    walkedNothing: walked === 0,
    changeTimes: fileChanges ? { complete: fileChanges.complete, futureDated: fileChanges.futureDated ?? 0 } : null,
    replaced: replaced.length,
    stems: stemsDropped,
    accepted,
    held: held ? candidates.size : 0,
  }));
  // Only once acted on: a walk that dies before here, or a held clear, asks
  // again from the old mark.
  if (fileChanges?.complete && !held) await import('../file-changes.js').then(m => m.saveMark(fileChanges.newest)).catch(() => {});
  const suspect = [...eraReasons.values()].reduce((a, b) => a + b, 0);
  if (suspect) {
    step.note(F.eraSuspectLine(suspect));
    runlog.debug(`era-suspect albums by reason: ${[...eraReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n.toLocaleString('en-GB')}`)
      .join(', ')}`);
  }
  return { walked, liveIds, replacedHeld: held ? candidates.size : 0 };
}

// Standalone reconcile: diff library-db against the live Navidrome catalogue and
// drop rows (and their vectors) for tracks that are gone — after adopting any
// rows whose id was rotated by Navidrome's canonical-id migration
// (music/id-rotation.ts), which is what makes this button the one-click
// recovery after that upgrade. No embedding preflight and no LLM — opens the
// existing DB at its stored dim so vectors are untouched.
//
// The shared walk is not read-only: it stamps era_untrusted on suspect albums
// and clears their stale album-tag years (#1418), leaving those tracks
// unknown-year until MusicBrainz is asked. Hence the backfill below — keyless,
// checked_at-stamped so later reconciles skip answered tracks, and throttled at
// MB's 1 req/s.
export async function reconcileOnly() {
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });
  const years = pendingYearsWanted();
  runlog.runLog.plan('Reconcile with the music server', [
    { id: 'walk', title: F.STEP_TITLE.walk },
    ...(years ? [{ id: 'years', title: F.STEP_TITLE.years }] : []),
  ], [navidromeWhere()]);
  const walkStep = runlog.step('walk', F.STEP_TITLE.walk);
  const { walked, liveIds, replacedHeld } = await walkNavidrome({ step: walkStep });
  let adopted = 0;
  let pruned = 0;
  let heldMessage = '';
  if (walked > 0) {
    let held;
    ({ adopted, pruned, held } = await adoptAndPrune(liveIds, {
      confirmMassPrune: process.argv.includes('--confirm-prune'),
    }));
    if (held) {
      heldMessage = held.message;
      runlog.problem('warning', held.message, { hold: true });
    }
    for (const line of F.walkChangeLines({ adopted, pruned })) walkStep.note(line);
    walkStep.done({ summary: F.walkSummary({ walked }) });
    reportCatalogueReady(walked);
    const yearStep = runlog.step('years', F.STEP_TITLE.years);
    const ids = pendingOriginalYearIds(false);
    if (ids.length === 0) yearStep.skip(years ? 'no original year is due' : 'original-year lookups are off');
    else {
      yearStep.start({ runsOn: yearSources(), scope: F.scopeMissing({ missing: ids.length, pool: walked, what: 'an original release year' }) });
      const stats = await backfillOriginalYears(ids, false, 4);
      yearStep.done({ summary: F.yearsSummary(stats) });
    }
  } else {
    // A transient empty Navidrome response must never wipe the DB.
    runlog.problem('warning', 'The music server listed no tracks, so nothing was removed. Check that its library is scanned and reachable.');
    walkStep.done({ summary: '0 tracks read', outcome: 'partial' });
    runlog.runLog.skipOpen(['years'], 'the walk read nothing');
  }
  const parts = [
    adopted > 0 ? `Re-linked ${adopted} track${adopted === 1 ? '' : 's'} after a Navidrome ID migration` : '',
    pruned > 0 ? `Removed ${pruned} track${pruned === 1 ? '' : 's'} no longer in Navidrome` : '',
    heldMessage ? 'Removal of missing tracks on hold (see the log)' : '',
    replacedHeld > 0 ? `Re-analysis of ${replacedHeld.toLocaleString('en-GB')} replaced file${replacedHeld === 1 ? '' : 's'} on hold (see the log)` : '',
  ].filter(Boolean);
  reportProgress({
    phase: 'done',
    label: parts.length ? parts.join('; ') : 'Library is in sync with Navidrome',
    done: adopted + pruned,
  });
  runlog.runLog.finish({ headline: parts.length ? parts.join('; ') : 'the library is in sync with the music server', library: '' });
  process.exit(0);
}

function pendingYearsWanted(): boolean {
  return ((settings.get() as any).embedding?.enrichment ?? {}).originalYear !== false;
}

// Mirrors server.ts boot: cloud API keys from secrets.env, Navidrome creds from
// setup-config.json. Standalone CLIs skip server.ts, so without this they fall
// back to the hardcoded `http://navidrome:4533`.
export async function applyWizardOverlay() {
  try {
    await loadSecretsIntoEnv();
  } catch (err: any) {
    console.error('[secrets] load failed:', err.message);
  }
  try {
    await loadNavidromeConfig();
  } catch (err: any) {
    console.error('[setup-config] load failed:', err.message);
  }
}
