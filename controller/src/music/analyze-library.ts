// Standalone acoustic-analysis CLI — `npm run analyze`. Runs the analysis pass
// (bpm / key / intro) alone; the same pass is the final phase of `npm run tag`.
// With no analyzer backend the pass is a no-op. Afterwards it re-embeds just the
// text vectors its measurements marked, when the embedding provider answers with
// the index's own model (tag-library/embed.ts reembedNewlyMarked); otherwise the
// marks wait for the next tag run.
//
//   --limit N      cap tracks analysed this run
//   --re-analyze   drop existing analysis and redo everything
//   --walk         force a Navidrome metadata refresh first
//   --skip-walk    never walk, even on an empty catalogue (wins over --walk)
//   --confirm-prune  allow a walk to remove more missing tracks than
//                  music/prune-policy.ts lets it remove on its own
//   --audio        backfill CLAP vectors on analysed tracks (implied by ANALYZE_AUDIO_EMBEDDING)
//   --vocal        backfill Demucs vocal ranges (implied by ANALYZE_VOCAL_ACTIVITY)
//
// The walk otherwise runs only on an empty catalogue (first-run bootstrap).
//
// Facet mode — scope read from track_facet_status instead of the legacy
// queries (music/acoustics-plan.ts). Never walks; --re-analyze/--audio/--vocal
// are ignored.
//   --facets F[,F]       head, loudness, tail, clap, vocal, stems, edges, year
//                        (year = the MusicBrainz original-year lookup for
//                        era-suspect tracks; it never calls the analyzer)
//   --where W            needs (default) | missing | unmeasurable[:reason] |
//                        failed | outdated | all
//   --ids a,b,c          restrict to these track ids
//   --ids-file PATH      …or to the ids in a file (one per line, # comments)
//   --limit N            cap the number of tracks planned
//   --dry-run            print the plan and exit: no lock and no analysis. Opening
//                        the DB may still create, seed or re-derive the facet
//                        status table, as any open does.
//
//   e.g. npm run analyze -- --facets clap --where failed --dry-run
//        npm run analyze -- --facets tail --where unmeasurable:capped --limit 200
//        npm run analyze -- --facets year --where unmeasurable:not-found

import * as subsonic from './subsonic.js';
import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { loadSecretsIntoEnv } from '../setup/secrets.js';
import { loadNavidromeConfig } from '../setup/config.js';
import { ANALYSIS_STEP, analysisStepDefs, runAnalysisPass } from './analyze.js';
import { adoptAndPrune } from './id-rotation.js';
import * as analyzer from './analyzer.js';
import { reportProgress } from './tagger-progress.js';
import * as runlog from './run-log.js';
import * as F from './run-log-format.js';
import { configuredAnalyzerHost, navidromeWhere, plannedAnalyzerWhere } from './run-log-where.js';
import { readFileSync } from 'node:fs';
import { analysisPart, formatPlan, parseFacets, parseWhere, planAcoustics, planStateFacets, yearPart, type AcousticsPlan } from './acoustics-plan.js';
import { runYearLookups, yearSources } from './original-year.js';
import { acquireStandaloneLock, installPidfileCleanup } from './tagger-lock.js';
import { walkFileInfo } from './tag-library/flags.js';
import { reembedNewlyMarked } from './tag-library/embed.js';

// TRUNCATE-checkpoint the library DB on every exit path, else this bulk writer
// leaves a huge WAL sidecar (#786). db.close() is synchronous, so 'exit' is safe.
process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

function parseIntFlag(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) ? n : undefined;
}

// Both maintenance workers use the same connection policy as the controller.
async function applyWizardOverlay() {
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

function stringFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

// --ids / --ids-file → explicit scope; neither → null (whole catalogue).
function explicitIds(args: string[]): string[] | null {
  const list = stringFlag(args, '--ids');
  const file = stringFlag(args, '--ids-file');
  if (!list && !file) return null;
  const raw = [
    ...(list ? list.split(',') : []),
    ...(file ? readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '')) : []),
  ];
  return [...new Set(raw.map(s => s.trim()).filter(Boolean))];
}

// Build the facet plan from the DB + whatever the analyzer says it can do.
async function buildFacetPlan(args: string[], limit: number | undefined): Promise<AcousticsPlan> {
  const facets = parseFacets(stringFlag(args, '--facets') ?? '');
  const where = parseWhere(stringFlag(args, '--where'));
  const known = db.allTrackIdsOrdered();
  let ids = known;
  const wanted = explicitIds(args);
  if (wanted) {
    const knownSet = new Set(known);
    ids = wanted.filter(id => knownSet.has(id));
    const unknown = wanted.length - ids.length;
    if (unknown > 0) runlog.note(`${unknown} of the given ids are not in the library: ignored`);
  }
  // Probe so capabilities are real; an unreachable analyzer leaves them unknown.
  // A year-only plan never talks to the analyzer, so it is not probed.
  const needsAnalyzer = facets.some(db.isAnalysisFacet);
  const available = needsAnalyzer ? await analyzer.isAvailable().catch(() => false) : false;
  if (needsAnalyzer && !available) runlog.problem('warning', F.analyzerUnreachableProblem(configuredAnalyzerHost()));
  const enrichCfg: { originalYear?: boolean } =
    (settings.get() as { embedding?: { enrichment?: { originalYear?: boolean } } }).embedding?.enrichment ?? {};
  return planAcoustics({
    ids,
    facets,
    where,
    // A vocal plan also reads tail and edges (planStateFacets).
    state: db.loadFacetState(planStateFacets(facets)),
    capabilities: {
      clap: available ? analyzer.audioEmbeddingAvailable() : null,
      demucs: available ? analyzer.vocalActivityAvailable() : null,
      tailVocal: available ? analyzer.tailVocalAvailable() : null,
      wholeFile: available ? analyzer.wholeFileAvailable() : null,
      yearLookups: enrichCfg.originalYear !== false,
      loudnessCurve: available ? analyzer.loudnessCurveAvailable() : null,
      tailLoudnessCurve: available ? analyzer.tailLoudnessCurveAvailable() : null,
      grid: available ? analyzer.gridAvailable() : null,
      structure: available ? analyzer.structureAvailable() : null,
    },
    limit,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const facetMode = args.includes('--facets');
  const dryRun = args.includes('--dry-run');
  if (dryRun && !facetMode) {
    console.error(F.problemLine('error', '--dry-run needs --facets'));
    process.exit(1);
  }

  // Single-flight: a controller-spawned run already holds the pidfile, so this
  // is a no-op there; a manual run claims the lock or refuses. A dry run reads
  // only, so it never takes (or waits for) the lock.
  let ownsLock = false;
  if (!dryRun) {
    try {
      ownsLock = acquireStandaloneLock('analyze', args);
    } catch (err: any) {
      console.error(F.problemLine('error', err.message));
      process.exit(1);
    }
  }
  if (ownsLock) installPidfileCleanup();

  const limit = parseIntFlag(args, '--limit');
  const reAnalyze = args.includes('--re-analyze');
  const forceWalk = args.includes('--walk');
  const skipWalk = args.includes('--skip-walk');
  // undefined → runAnalysisPass falls back to the ANALYZE_AUDIO_EMBEDDING env.
  const audioBackfill = args.includes('--audio') ? true : undefined;
  // undefined → falls back to ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  const vocalBackfill = args.includes('--vocal') ? true : undefined;

  await applyWizardOverlay();
  await settings.load();
  const embeddingDim = embeddings.resolveEmbeddingDim();
  // adoptStoredDim so an embedding dim swap can't block analysis, which never
  // touches vectors (#319).
  await db.open({ embeddingDim, adoptStoredDim: true });

  if (facetMode) {
    let plan: AcousticsPlan;
    try {
      plan = await buildFacetPlan(args, limit);
    } catch (err: any) {
      console.error(F.problemLine('error', err.message));
      process.exit(1);
    }
    if (dryRun) {
      // The plan itself is the output of a dry run, in its own table.
      for (const line of formatPlan(plan)) console.log(line);
      analyzer.shutdown();
      console.log('Dry run: nothing analysed.');
      process.exit(0);
    }
    const audio = analysisPart(plan);
    const yearIds = yearPart(plan);
    runlog.runLog.plan('Analysis run', [
      ...(audio ? [{ id: ANALYSIS_STEP.models, title: F.facetPlanTitle(audio.facets) }] : []),
      ...(audio && audio.facets.includes('clap') ? [{ id: ANALYSIS_STEP.score, title: F.STEP_TITLE.score }] : []),
      ...(audio ? [{ id: 'refresh', title: F.STEP_TITLE.refresh }] : []),
      ...(yearIds.length ? [{ id: 'years', title: F.STEP_TITLE.years }] : []),
    ], [...(audio ? [plannedAnalyzerWhere()] : []), ...(yearIds.length ? [yearSources()] : [])]);
    for (const line of formatPlan(plan)) runlog.debug(line);
    if (plan.items.length === 0) {
      analyzer.shutdown();
      runlog.runLog.finish({ headline: 'nothing planned', library: '' });
      process.exit(0);
    }
    // Audio first, then the MusicBrainz lookups: two independent passes.
    const dirtyBefore = new Set(db.textVectorDirtyIds());
    const stats = audio ? await runAnalysisPass({ plan: audio }) : null;
    analyzer.shutdown();
    if (stats) runlog.debug(`stats: ${JSON.stringify(stats)}`);
    if (audio) await reembedNewlyMarked(dirtyBefore);
    if (yearIds.length) {
      // Planned means due: a not-found re-asked by --where unmeasurable/all is
      // asked again, a resolved or manual year never is (the planner skipped it).
      const st = runlog.step('years', F.STEP_TITLE.years);
      st.start({ runsOn: yearSources(), scope: F.scopeMissing({ missing: yearIds.length, pool: db.trackCount(), what: 'an original release year' }) });
      const years = await runYearLookups(yearIds, { force: true });
      st.done({ summary: F.yearsSummary(years) });
    }
    runlog.runLog.finish({ headline: analysisHeadline(stats), library: '' });
    process.exit(0);
  }

  // Walk only when forced, or when the catalogue is empty (bootstrap).
  // --skip-walk hard-disables either way.
  const count = db.trackCount();
  const shouldWalk = !skipWalk && (forceWalk || count === 0);
  runlog.runLog.plan('Analysis run', [
    ...(shouldWalk ? [{ id: 'walk', title: F.STEP_TITLE.walk }] : []),
    ...analysisStepDefs({ audioBackfill, vocalBackfill }),
    { id: 'refresh', title: F.STEP_TITLE.refresh },
  ], [...(shouldWalk ? [navidromeWhere()] : []), plannedAnalyzerWhere()]);
  if (!shouldWalk) {
    runlog.debug(skipWalk ? '--skip-walk: track details not refreshed'
      : `the library holds ${count} tracks: no walk (--walk forces one)`);
  }

  if (shouldWalk) {
    const st = runlog.step('walk', F.STEP_TITLE.walk);
    st.start({ runsOn: navidromeWhere(), scope: F.walkScope(count) });
    reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: 0 });
    let walked = 0;
    const liveIds = new Set<string>();
    // A walk that prunes must be complete (same rule as the tagger's walk):
    // with the best-effort walk, an album whose getAlbum failed was skipped
    // and its tracks then deleted as "no longer in Navidrome", with every
    // tag, analysis and vector on them. An incomplete walk keeps the metadata
    // it refreshed, prunes nothing and lets the analysis pass run.
    let walkComplete = true;
    try {
      for await (const song of subsonic.iterateAllSongs({ requireComplete: true })) {
        db.upsertTrackMeta(song.id, {
          title: song.title,
          artist: song.artist,
          album: song.album,
          // Same ids the tagger's walk records; must not be NULL on an
          // analyzer-only catalogue.
          albumId: song.albumId ?? null,
          artistId: song.artistId ?? null,
          albumArtistId: song.albumArtistId ?? null,
          year: song.year,
          genres: subsonic.songGenres(song),
          duration: song.duration,
          // A walk, so always a value: this is how a tag that has gone clears.
          explicitStatus: db.normaliseExplicitStatus(song.explicitStatus),
          ...walkFileInfo(song),
        });
        liveIds.add(song.id);
        walked += 1;
        if (walked % 500 === 0) {
          st.progressCount(walked, 'tracks read', count || null);
          reportProgress({ phase: 'walk', label: 'Scanning Navidrome library', done: walked });
        }
      }
    } catch (err) {
      walkComplete = false;
      const why = err instanceof Error ? err.message : String(err);
      runlog.problem('warning', F.walkStoppedProblem(walked, why));
    }

    // Reconcile: adopt rows whose id was rotated by Navidrome's canonical-id
    // migration (music/id-rotation.ts — analysis carries over instead of being
    // recomputed), then drop rows for tracks genuinely no longer in Navidrome
    // so the analysis scope reflects the live catalogue, not orphans from past
    // full rescans. Guarded on a non-empty walk (a complete, authoritative pass).
    //
    // Note this is NOT a recovery path an operator can reach from the admin UI:
    // `shouldWalk` is false on a populated catalogue and startAnalyzer passes no
    // --walk, so after a rotation (where the catalogue is full of stale rows)
    // only a host-side `--walk` run gets here. The two real recovery paths are
    // the tagger run and Library → Reconcile with Navidrome. Adoption is wired
    // here anyway so the CLI can't be the one path that prunes what the others
    // adopt.
    let adopted = 0;
    let pruned = 0;
    if (walkComplete && walked > 0) {
      const r = await adoptAndPrune(liveIds, { confirmMassPrune: args.includes('--confirm-prune') });
      if (r.held) runlog.problem('warning', r.held.message, { hold: true });
      adopted = r.adopted;
      pruned = r.pruned;
    }
    for (const line of F.walkChangeLines({ adopted, pruned })) st.note(line);
    st.done({ summary: F.walkSummary({ walked }), outcome: walkComplete ? 'ok' : 'partial' });
  }

  const dirtyBefore = new Set(db.textVectorDirtyIds());
  const stats = await runAnalysisPass({ limit, reAnalyze, audioBackfill, vocalBackfill });
  analyzer.shutdown();
  runlog.debug(`stats: ${JSON.stringify(stats)}`);
  // The vectors this pass's measurements marked (#2236) get their Sound: line now,
  // not at the next tag run (#2313). Skipped, with the marks kept, unless the
  // embedding provider answers with the index's own model.
  await reembedNewlyMarked(dirtyBefore);
  runlog.runLog.finish({ headline: analysisHeadline(stats), library: '' });
  process.exit(0);
}

// The closing block's headline: what the analysis did, all steps summed.
function analysisHeadline(stats: Awaited<ReturnType<typeof runAnalysisPass>> | null): string {
  if (!stats) return '';
  if (!stats.available) return 'no audio analysis: the analyzer did not answer';
  const analysed = stats.analyzed + (stats.wholeFile?.analyzed ?? 0) + (stats.beatGrid?.analyzed ?? 0);
  const failed = stats.failed + (stats.wholeFile?.failed ?? 0) + (stats.beatGrid?.failed ?? 0);
  return `${F.fmtCount(analysed)} track analyses done, ${F.fmtCount(failed)} failed`;
}

main().catch((err) => {
  console.error(F.problemLine('error', `The analysis run stopped: ${err?.stack || err}`));
  process.exit(1);
});
