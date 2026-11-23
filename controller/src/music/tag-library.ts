// Library tagger orchestrator. Phases: 0 enrich → 1 embed → 2 seed →
// 3 KNN-propagate → 4 active-learn → 5 acoustic analyze, then a forward run
// re-embeds the vectors phase 5's measurements marked. Each phase
// short-circuits cleanly so partial runs make progress.
//
// Run:  docker exec sub-wave-controller npx tsx src/music/tag-library.ts
// Flags:
//   --limit N             cap NEW tracks considered this run (default: all)
//   --batch N             LLM batch size (default 25)
//   --seeds N             override seed budget
//   --max-rounds N        cap active-learning rounds (default 3)
//   --no-propagate        only embed + seed, skip phases 3-4 (debug)
//   --reseed              drop + rebuild track_vectors; re-embed from scratch
//   --re-enrich           null out enrichment cache and re-fetch from Navidrome
//   --skip-enrich         embed using metadata only (debug)
//   --skip-analyze        skip the acoustic bpm/key pass (Phase 5)
//   --skip-tag            skip embed + mood tagging (phases 1-4); walk/enrich/
//                         analyze still run per their flags
//   --no-prune            walk Navidrome but don't drop orphaned rows
//   --vocal / --no-vocal  force the Phase-5 Demucs vocal pass on / off (else
//                         defers to settings.audio.vocalActivity)
//   --upgrade             re-LLM-tag tagged rows with stale promptHash/model
//                         (never source='manual'). promptHash keys off
//                         TAGGER_CONTRACT_VERSION + the mood vocabulary, not
//                         the prompt text (#1548).
//   --upgrade-blind       with --upgrade: re-tag only rows the LLM tagged
//                         without audio measurements that have been measured
//                         since (#2281), whatever their stamp
//   --rescan              fire ONLY the selected re-* passes, each scoped to
//                         already-done tracks; never forward-process the
//                         untagged remainder

import * as db from './library-db.js';
import * as settings from '../settings.js';
import * as embeddings from './embeddings.js';
import { selectSeeds } from './seed-selector.js';
import { selectEnrichIds } from './enrich-scope.js';
import { vote, fuseNeighbours } from './tag-propagator.js';
import { activeModelLabel } from '../llm/provider.js';
import { setCallLineMirror, setRawDebugStderrMirror } from '../llm/log.js';
import { analysisStepDefs, runAnalysisPass } from './analyze.js';
import { adoptAndPrune } from './id-rotation.js';
import { reportProgress, reportCatalogueReady, sortedPhaseTimings } from './tagger-progress.js';
import { planRun } from './rescan-scope.js';
import { acquireStandaloneLock, installPidfileCleanup } from './tagger-lock.js';
import { embeddingPreflight, indexTextMode, phaseEmbed } from './tag-library/embed.js';
import * as runlog from './run-log.js';
import * as F from './run-log-format.js';
import { embeddingsWhere, LASTFM_WHERE, LOCAL_WHERE, modelName, navidromeWhere, plannedAnalyzerWhere } from './run-log-where.js';
import { enrichSwitches, phaseEnrich } from './tag-library/enrich.js';
import { yearSources } from './original-year.js';
import {
  applyWizardOverlay,
  clamp01,
  parseFlags,
  reconcileOnly,
  walkNavidrome,
} from './tag-library/flags.js';
import { llmTagInBatches, resolveTagConsumers } from './tag-library/tag.js';
import { propagationSelfCheck, type SelfCheckResult } from './tag-library/self-check.js';
import { rememberedUntaggable, tagPromptStamp } from './tag-library/tag-input.js';
import { audioEnergyOptions, runAudioEnergyPass } from './propagated-energy.js';


// Close (TRUNCATE-checkpoints the WAL) on every exit path; this CLI bails via
// process.exit() from several places (#786). db.close() is synchronous, so it
// is safe in an 'exit' hook.
process.on('exit', () => {
  try { if (db.isOpen()) db.close(); } catch { /* best-effort */ }
});

async function main() {
  const flags = parseFlags();
  const startedAt = Date.now();

  // Mute the stderr mirror of the raw-LLM debug capture; the file still gets it.
  setRawDebugStderrMirror(false);
  // One line per LLM call is noise in a run log that sums the calls up; it is
  // kept behind --verbose.
  setCallLineMirror(runlog.runLog.verbose);

  // Single-flight: no-op for a controller-spawned run (already pidfiled). A
  // manual `npm run tag` claims the lock so it can't become a second DB writer.
  let ownsLock = false;
  try {
    ownsLock = acquireStandaloneLock(flags.reconcileOnly ? 'reconcile' : 'tag', process.argv.slice(2));
  } catch (err: any) {
    console.error(F.problemLine('error', err.message));
    process.exit(1);
  }
  if (ownsLock) installPidfileCleanup();

  // Per-phase wall-clock: lap(name) attributes the time since the previous lap.
  const timings: Record<string, number> = {};
  let phaseT0 = startedAt;
  const lap = (name: string): void => {
    const now = Date.now();
    timings[name] = (timings[name] || 0) + (now - phaseT0);
    phaseT0 = now;
  };

  await applyWizardOverlay();
  await settings.load();

  // Reconcile is a pure catalogue diff — short-circuit before any embedding /
  // LLM setup so it runs even when embeddings are disabled or unconfigured.
  if (flags.reconcileOnly) {
    await reconcileOnly();
    return;
  }

  // Preflight before opening the DB or walking Navidrome (#174, #319), the same
  // one a standalone Analyse run makes before its re-embed (tag-library/embed.ts).
  const preflight = await embeddingPreflight();
  if (!preflight.ok) {
    runlog.problem('error', F.embeddingFailedProblem(embeddingsWhere(), preflight.message));
    process.exit(1);
  }
  const embeddingDim = preflight.dim;

  // reseed lets open() recover from a model/dim swap instead of throwing the
  // dim-mismatch before the --reseed logic below runs (#307). Same-dim: no-op.
  await db.open({ embeddingDim, reseed: flags.reseed });

  // Task-prefix mode this run embeds documents in (tag-library/embed.ts, the one
  // rule both CLIs use).
  const textMode = indexTextMode(flags.reseed);
  // Embed-text shape the index carries (#1246), same "describe what's stored"
  // rule as textMode: stays at the older format until a reseed rebuilds it.
  const textFormat = embeddings.resolveIndexTextFormat(
    db.getEmbeddingMeta()?.textFormat, db.vectorCount(), flags.reseed,
  );
  db.setEmbeddingMeta(embeddings.activeModelLabel(), embeddingDim, textMode, textFormat);
  // Said under the banner (it names a one-off the operator can run).
  const prefixHint = textMode === 'plain' && embeddings.preferredTextMode() === 'prefixed'
    ? `${modelName(embeddings.activeModelLabel())} finds similar tracks better with task prefixes: run ` +
      '“Re-embed all tracks” once (admin Re-scan tab, or --reseed) to upgrade the index.'
    : null;

  // Tunables from settings.embedding, CLI flags override where present. The ??
  // fallbacks mirror DEFAULTS.embedding in settings.ts.
  const embedCfg: any = (settings.get() as any).embedding ?? {};
  const maxRounds = flags.maxRounds ?? Math.max(0, embedCfg.maxActiveLearningRounds ?? 3);
  const tagBatchSize = flags.batchSize ?? Math.max(1, Math.min(50, embedCfg.batchSize ?? 25));
  const knnK = Math.max(1, embedCfg.knnNeighbours ?? 10);
  const moodVoteThreshold = clamp01(embedCfg.moodVoteThreshold ?? 0.4);
  const confidenceThreshold = clamp01(embedCfg.confidenceThreshold ?? 0.35);
  const seedCountCfg =
    typeof embedCfg.seedCount === 'number' && embedCfg.seedCount > 0
      ? embedCfg.seedCount
      : null;

  // Shared vote plumbing for phase 3, the phase-4 re-propagation rounds and the
  // post-run self-check: KNN → neighbour-tag lookup → similarity-weighted vote.
  // Audio-KNN neighbours fuse in at audioFusionWeight first; knnAudioById
  // returns [] for un-analysed tracks, so fusion degrades to text-only per
  // track, not per run.
  //
  // The three damping weights all exist because a text embedding clusters by
  // artist/album, so an undamped vote lets one mistagged seed sweep a whole
  // album or catalogue, and a propagated voter feeding the next round is an
  // undamped feedback loop.
  const SAME_ALBUM_WEIGHT = 0.5;
  const SAME_ARTIST_WEIGHT = 0.6;
  const PROPAGATED_VOTE_WEIGHT = 0.7;
  const audioFusionWeight = clamp01(embedCfg.audioFusionWeight ?? 0.5);
  const voteForTrack = (id: string) => {
    const target = db.getTrack(id);
    const textNeighbours = db.knnById(id, knnK);
    const neighbours =
      audioFusionWeight > 0
        ? fuseNeighbours(textNeighbours, db.knnAudioById(id, knnK), audioFusionWeight, knnK)
        : textNeighbours;
    return vote(
      neighbours,
      (nId) => {
        const t = db.getTrack(nId);
        if (!t || t.moods.length === 0) return null;
        return { moods: t.moods, energy: t.energy };
      },
      {
        moodVoteThreshold,
        k: knnK,
        weightOf: (nId) => {
          const n = db.getTrack(nId);
          let w = 1;
          if (target?.artist && n?.artist === target.artist) {
            w = target?.album && n?.album === target.album
              ? SAME_ALBUM_WEIGHT
              : SAME_ARTIST_WEIGHT;
          }
          // Multiplied, not min-ed: a same-artist propagated voter is both
          // relations at once.
          if (n?.source === 'propagated') w *= PROPAGATED_VOTE_WEIGHT;
          return w;
        },
      },
    );
  };

  // Tuning numbers: --verbose only.
  runlog.debug(
    `tuning: batch=${tagBatchSize} maxRounds=${maxRounds} knnK=${knnK} moodVote=${moodVoteThreshold} ` +
      `confidence=${confidenceThreshold} audioFusion=${audioFusionWeight} ` +
      `(${db.audioVectorCount()} sounds-like vectors join the vote)`,
  );

  // Only a re-scan re-embed needs this snapshot; a normal --reseed rebuilds as
  // part of its forward pass.
  let reembedIds: string[] = [];
  if (flags.reseed) {
    // A same-dim reseed still has the old vectors here, so this captures the
    // already-embedded population. A dim-change reseed already had
    // track_vectors dropped inside open(), so it comes back empty.
    if (flags.rescan) reembedIds = db.embeddedIds();
    runlog.debug('--reseed: similarity vectors dropped, rebuilt from scratch');
    db.dropVectors();
    // Dim change wiped the vectors before the snapshot, so rebuild everything
    // that now needs a vector — otherwise the pass rebuilds 0 on exactly the
    // model swap it advertises.
    if (flags.rescan && reembedIds.length === 0) reembedIds = db.unembeddedIds();
  }

  const promptHash = tagPromptStamp();
  const modelLabel = activeModelLabel();

  // Single- vs dual-LLM tagging: probed once here, not per phase, so the banner
  // names the LLMs once.
  const llm = await resolveTagConsumers();
  const tagConsumers = llm.consumers;

  // Which phases run this pass (pure; pinned by rescan-scope.test.ts).
  const plan = planRun(flags);
  // The self-check runs alongside the analysis when the analysis is the next
  // thing to run (see below), and is reported once it ends.
  const overlap = plan.analyze && !plan.reEmbed && !plan.reDecide;
  const embedModel = modelName(embeddings.activeModelLabel());
  const tagModel = modelName(activeModelLabel());
  const on = enrichSwitches();
  const steps: runlog.StepDef[] = [
    { id: 'walk', title: F.STEP_TITLE.walk },
    ...(plan.enrich ? [{ id: 'enrich', title: F.enrichTitle(on) }] : []),
    ...(plan.forwardTag ? [
      { id: 'embed', title: `Build similarity vectors with ${embedModel}` },
      { id: 'tag', title: `Mood tagging with ${tagModel}` },
      { id: 'spread', title: F.STEP_TITLE.spread },
      ...(overlap ? [] : [{ id: 'selfcheck', title: F.STEP_TITLE.selfCheck }]),
      { id: 'energy', title: F.STEP_TITLE.energy },
    ] : []),
    ...(plan.reEmbed ? [{ id: 'reembed', title: `Rebuild every similarity vector with ${embedModel}` }] : []),
    ...(plan.reDecide ? [{
      id: 'redecide',
      title: flags.upgradeBlind ? `Re-tag the tracks tagged before they were measured, with ${tagModel}` : `Re-tag stale moods with ${tagModel}`,
    }] : []),
    ...(plan.analyze ? analysisStepDefs({ vocalBackfill: flags.vocal ? true : flags.noVocal ? false : undefined }) : []),
    ...(plan.forwardTag && overlap ? [{ id: 'selfcheck', title: F.STEP_TITLE.selfCheck }] : []),
    ...(plan.forwardTag && plan.analyze ? [{ id: 'refresh', title: F.STEP_TITLE.refresh }] : []),
  ];
  runlog.runLog.plan(
    flags.rescan ? 'Re-scan run' : 'Tagging run',
    steps,
    [
      navidromeWhere(),
      ...(plan.enrich && on.lastfm ? [LASTFM_WHERE] : []),
      ...(plan.enrich && on.years ? [yearSources()] : []),
      ...(plan.forwardTag || plan.reDecide ? llm.machines : []),
      ...(plan.forwardTag || plan.reEmbed ? [embeddingsWhere()] : []),
      ...(plan.analyze ? [plannedAnalyzerWhere()] : []),
    ],
  );
  if (prefixHint) runlog.note(prefixHint);
  const byLeg: Record<string, number> = {};
  const mergeByLeg = (m: Record<string, number>) => {
    for (const [k, v] of Object.entries(m)) byLeg[k] = (byLeg[k] || 0) + v;
  };

  // Walk Navidrome and upsert track metadata, so later phases work purely off SQL.
  lap('setup');
  const walkStep = runlog.step('walk', F.STEP_TITLE.walk);
  let walk: Awaited<ReturnType<typeof walkNavidrome>>;
  try {
    walk = await walkNavidrome({ step: walkStep });
  } catch (err: any) {
    runlog.problem('error', F.musicServerUnreachableProblem(navidromeWhere().replace(/^Navidrome at /, ''), String(err?.message || err)));
    walkStep.done({ summary: 'the library could not be read', outcome: 'failed' });
    process.exit(1);
  }
  const { walked, liveIds, replaced } = walk;
  let pruned = 0;
  let adopted = 0;

  // Reconcile against the live catalogue. The walk above is complete and
  // authoritative, so any track row it didn't see is gone from Navidrome
  // (typically after a full rescan that re-mints IDs). Adoption first
  // (music/id-rotation.ts): rows whose id was rotated by Navidrome's canonical
  // migration carry their tags/analysis/vectors onto the new id instead of
  // being re-derived from zero; the prune then only sees genuinely deleted
  // rows, keeping coverage %, untagged scope and analysis scope honest.
  // Guarded on a non-empty walk so a transient empty Navidrome response can't
  // wipe the DB; --no-prune skips both (adoption is a mutation too).
  if (flags.noPrune) {
    walkStep.note('Tracks gone from the server are kept this run (--no-prune).');
  } else if (walked > 0) {
    const r = await adoptAndPrune(liveIds, { confirmMassPrune: flags.confirmPrune });
    if (r.held) runlog.problem('warning', r.held.message, { hold: true });
    pruned = r.pruned;
    adopted = r.adopted;
    reportCatalogueReady(walked);
  }
  lap('walk');

  // Forward scope: the untagged tracks this run discovers and tags, capped by
  // --limit. A re-scan's forward scope is empty — each re-* pass below redoes
  // only tracks that already carry that artifact, never the remainder.
  // Tracks the LLM already found untaggable with this same input, prompt stamp
  // and model (#2283) stay in scope for enrich, embed and propagation, but never
  // go to the LLM again. They sort last, so a --limit spends itself on the rest.
  const noLlm = rememberedUntaggable(promptHash, tagConsumers.map(c => c.label));
  const untaggedAll = db.untaggedIds();
  const allUntagged = [
    ...untaggedAll.filter(id => !noLlm.has(id)),
    ...untaggedAll.filter(id => noLlm.has(id)),
  ];
  const targetUntagged = flags.rescan
    ? []
    : flags.limit === Infinity
      ? allUntagged
      : allUntagged.slice(0, flags.limit);
  // The remembered untaggables are in scope but not "to tag": count them apart.
  const heldBack = targetUntagged.filter(id => noLlm.has(id)).length;
  for (const line of F.walkChangeLines({ adopted, pruned })) walkStep.note(line);
  // So the analysis steps can say where their tracks come from.
  runlog.runLog.setOrigins({ new: targetUntagged, replaced });
  walkStep.done({
    summary: F.walkSummary({ walked, newTracks: flags.rescan ? 0 : targetUntagged.length - heldBack }),
    outcome: walked > 0 ? 'ok' : 'partial',
  });
  if (flags.rescan) {
    runlog.note(`Re-scan: only the selected passes are redone, over tracks already done (${F.fmtCount(allUntagged.length)} untagged tracks wait for a normal run).`);
  } else {
    if (targetUntagged.length < allUntagged.length) {
      runlog.note(`${F.fmtCount(targetUntagged.length)} of ${F.fmtCount(allUntagged.length)} untagged tracks are taken this run (--limit).`);
    }
    if (heldBack > 0) {
      runlog.note(
        `${F.fmtCount(heldBack)} more are held back from the LLM: they came back untaggable before ` +
          'with the same details, prompt and model (they can still take their neighbours\' moods).',
      );
    }
  }

  // Phase 0: ENRICH. Normal runs enrich only the in-scope untagged tracks;
  // --re-enrich widens scope to the whole walked catalogue, since untagged is
  // empty on a fully-tagged library (#531). phaseEnrich bypasses the per-track
  // enrichedAt cache when reEnrich is set; --limit still caps the count.
  if (plan.enrich) {
    const enrichIds = selectEnrichIds({
      reEnrich: flags.reEnrich,
      rescan: flags.rescan,
      limit: flags.limit,
      liveIds,
      // Re-scan re-enrich redoes only the already-enriched population.
      enrichedIds: flags.rescan ? db.enrichedIds() : undefined,
      targetUntagged,
    });
    const enrichStep = runlog.step('enrich', F.enrichTitle(on));
    if (flags.reEnrich) {
      runlog.debug(`--re-enrich: refreshing details for ${enrichIds.length} ${flags.rescan ? 'already-enriched tracks' : 'tracks'}`);
    }
    await phaseEnrich(enrichIds, flags.reEnrich, flags.limit, enrichStep);
  }
  lap('enrich');

  // Phases 1-4 (embed → seed → propagate → active-learn), the "Tag moods" step.
  // A re-scan suppresses them and runs the scoped re-embed / re-decide passes
  // below instead. llmCalls/llmTagged are hoisted so finish() still reports 0
  // when tagging is skipped.
  let llmCalls = 0;
  let llmTagged = 0;
  // The rows phases 3-4 propagated in this run, for the re-vote after the
  // trailing re-embed below.
  const propagatedThisRun = new Set<string>();
  // The propagation self-check, when it runs alongside the analysis (it reads
  // only; awaited before the re-vote rewrites tags).
  let selfCheck: Promise<SelfCheckResult | null> = Promise.resolve(null);
  let selfCheckAt = 0;
  if (plan.forwardTag) {
    await phaseEmbed(targetUntagged, tagBatchSize, textMode, runlog.step('embed'), 'new');
    lap('embed');

    // Phase 2: SEED. CLI --seeds wins, then settings.embedding.seedCount, then
    // auto. --limit also clamps to the in-scope size.
    const rawSeedCount = flags.seedCount ?? seedCountCfg ?? autoSeedCount(walked);
    const limited = flags.limit !== Infinity;
    const seedCount = limited
      ? Math.min(rawSeedCount, targetUntagged.length)
      : rawSeedCount;
    runlog.debug(limited && seedCount < rawSeedCount
      ? `seed budget clamped from ${rawSeedCount} to ${seedCount} by --limit`
      : `seed budget: ${seedCount}`);

    const seedSelection = await selectSeeds({
      seedCount,
      // --limit must reach the seed layer too, or layers 2-4 pull picks from
      // the full untagged pool. Bulk runs pass undefined.
      untaggedPool: limited ? new Set(targetUntagged) : undefined,
      skip: noLlm,
      // k-means diversity layer. Candidates without a vector return null and
      // drop out inside the selector; the shortfall tops up randomly.
      embeddingForId: (id) => db.getVector(id),
    });
    runlog.debug(`seeds: ${seedSelection.seeds.length} (by layer: ${JSON.stringify(seedSelection.layerCounts)})`);

    const tagStep = runlog.step('tag');
    if (seedSelection.seeds.length > 0) {
      tagStep.start({
        runsOn: llm.machines.join(' + '),
        scope: F.tagScope({ asked: seedSelection.seeds.length, newTracks: targetUntagged.length }),
      });
      if (llm.notice) runlog.problem('warning', llm.notice);
      const tagged = await llmTagInBatches(
        seedSelection.seeds, tagBatchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);
      for (const id of tagged.untaggable) noLlm.add(id);
      tagStep.done(F.tagResult({
        asked: seedSelection.seeds.length, tagged: tagged.tagged, untaggable: tagged.untaggable.length, calls: tagged.callCount,
      }));
    } else {
      tagStep.skip(targetUntagged.length === 0 ? 'no new tracks to tag' : 'no track left to ask the LLM about');
    }
    lap('seed');

    if (flags.noPropagate) {
      runlog.runLog.skipOpen(['spread', 'selfcheck', 'energy'], 'stopped after mood tagging (--no-propagate)');
      return finish(llmCalls, llmTagged, byLeg, timings);
    }

    // Phase 3: PROPAGATE, over in-scope tracks that have an embedding. Tracks
    // without vectors have no neighbours and would just burn phase-4 budget.
    let propagated = 0;
    let uncertain: string[] = [];
    let scanned = 0;
    let rounds = 0;
    const spreadStep = runlog.step('spread');
    const considered = targetUntagged.filter(id => !db.hasTags(id)).length;
    if (considered === 0) spreadStep.skip('no new track is left without moods');
    else {
      spreadStep.start({
        runsOn: `${LOCAL_WHERE} (similar tracks by text${audioFusionWeight > 0 ? ' and sound' : ''})` +
          (maxRounds > 0 ? ` · the LLM again for the unsure ones` : ''),
        scope: `${F.fmtCount(considered)} new tracks without moods`,
      });
    }

    reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: 0, total: targetUntagged.length });
    for (const id of targetUntagged) {
      scanned += 1;
      // Synchronous loop; emit sparsely so a 30k-track scan doesn't spam stdout.
      if (scanned % 500 === 0) {
        reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: scanned, total: targetUntagged.length });
      }
      if (db.hasTags(id)) continue;        // already seeded
      if (!db.hasVector(id)) continue;     // no embedding → can't propagate
      const result = voteForTrack(id);
      if (
        result.votingNeighbours >= 1 &&
        result.confidence >= confidenceThreshold &&
        result.moods.length > 0
      ) {
        db.upsertTrackTags(id, {
          moods: result.moods,
          energy: result.energy,
          source: 'propagated',
          confidence: result.confidence,
          promptHash,
          model: modelLabel,
        });
        propagatedThisRun.add(id);
        propagated += 1;
      } else if (!noLlm.has(id)) {
        // An untaggable track may still take its neighbours' vote above, but
        // asking the LLM again would get the same empty answer.
        uncertain.push(id);
      }
    }
    runlog.debug(`first vote: ${propagated} spread, ${uncertain.length} unsure`);
    reportProgress({ phase: 'propagate', label: 'Propagating tags to neighbours', done: targetUntagged.length, total: targetUntagged.length });
    lap('propagate');

    // Phase 4: ACTIVE-LEARN.
    for (let round = 1; round <= maxRounds; round++) {
      if (uncertain.length === 0) break;
      rounds = round;
      spreadStep.note(`Round ${round}: ${F.fmtCount(uncertain.length)} unsure tracks asked to the LLM again`);
      const tagged = await llmTagInBatches(
        uncertain,
        tagBatchSize,
        promptHash,
        'uncertain-llm',
        tagConsumers,
        { phase: 'learn', round },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);
      for (const id of tagged.untaggable) noLlm.add(id);

      // Re-propagate over in-scope tracks still untagged after this LLM round.
      let extra = 0;
      const stillUncertain: string[] = [];
      for (const id of targetUntagged) {
        if (db.hasTags(id)) continue;
        if (!db.hasVector(id)) continue;
        const result = voteForTrack(id);
        if (
          result.votingNeighbours >= 1 &&
          result.confidence >= confidenceThreshold &&
          result.moods.length > 0
        ) {
          db.upsertTrackTags(id, {
            moods: result.moods,
            energy: result.energy,
            source: 'propagated',
            confidence: result.confidence,
            promptHash,
            model: modelLabel,
          });
          propagatedThisRun.add(id);
          extra += 1;
        } else if (!noLlm.has(id)) {
          stillUncertain.push(id);
        }
      }
      propagated += extra;
      runlog.debug(`round ${round}: ${extra} more spread, ${stillUncertain.length} still unsure`);

      // Converged if no new propagation happened this round.
      if (stillUncertain.length === uncertain.length) {
        runlog.debug('converged: no further spread possible');
        uncertain = stillUncertain;
        break;
      }
      uncertain = stillUncertain;
    }
    if (considered > 0) spreadStep.done({ summary: F.spreadResult({ spread: propagated, unsure: uncertain.length, rounds, considered }) });
    lap('learn');

    // Self-check: re-run the vote on a sample of directly-decided tracks (KNN
    // excludes self) and score against the stored truth. A relative signal for
    // judging knob changes run-over-run, not a benchmark (see
    // propagation-eval.ts). Best-effort: never fails the run, and it writes
    // nothing. Each vote is two brute-force KNN scans over the whole index
    // (about a quarter second on a 75k-track library), so the check costs
    // half a minute of this process's CPU; when the acoustic analysis follows,
    // it runs alongside it (selfCheck below), which spends that time waiting
    // on the analyzer, instead of before it. Its sample and that sample's
    // truth are read now, as before; its votes may then see what the energy
    // check and the analysis change meanwhile (an audio-corrected energy, the
    // CLAP vectors of this run's tracks), which moves only its log line.
    // Alongside only when the analysis is the next thing to run: a re-embed
    // or a re-decide in between would rebuild the vectors or rewrite the
    // moods it votes over.
    selfCheckAt = Date.now();
    selfCheck = propagationSelfCheck(voteForTrack, confidenceThreshold, { yieldBetweenVotes: overlap });
    if (!overlap) reportSelfCheck(await selfCheck, selfCheckAt, false);
    lap('eval');

    // Audio-derived energy over the rows phases 3-4 propagated: decisive stored
    // mood cosines overrule an inherited energy (#1362). Runs here, not inside
    // the propagation loop, so it stays ONE correction path shared with the
    // analysis pass (a library can gain audio scores long after tagging).
    // Best-effort: never fails the run.
    const energyStep = runlog.step('energy');
    try {
      const at = Date.now();
      const stats = runAudioEnergyPass(audioEnergyOptions(settings.get()));
      const r = F.energyResult(stats);
      if ('skip' in r) energyStep.skip(r.skip);
      else {
        energyStep.start({ runsOn: `${LOCAL_WHERE} (from the stored audio mood scores)`, at });
        energyStep.done({ summary: F.energyChanged(stats) });
        energyStep.note(F.energyDetail(stats)!);
      }
    } catch (err: any) {
      runlog.problem('warning', `The energy check failed (the next run retries): ${err?.message || err}`);
      energyStep.skip('stopped by an error');
    }
  }

  // Re-scan RE-EMBED: rebuild vectors under the new embedding model, from the
  // scope resolved above, so the KNN graph the existing tags anchor is restored.
  if (plan.reEmbed) {
    await phaseEmbed(reembedIds, tagBatchSize, textMode, runlog.step('reembed'), 'rebuild');
    lap('embed');
  }

  // Re-scan RE-DECIDE: re-LLM-tag tagged rows whose prompt or model went stale
  // (never manual). Scoped to the tagged set, never the untagged remainder.
  // --upgrade-blind swaps the scope for the rows tagged without measurements
  // that have been measured since (#2281); it never adds the stale ones.
  if (plan.reDecide) {
    const reDecideLimit = flags.limit === Infinity ? undefined : flags.limit;
    const redo = flags.upgradeBlind
      ? db.blindTaggedIds(reDecideLimit)
      : db.staleTaggedIds(promptHash, modelLabel, reDecideLimit);
    const redoStep = runlog.step('redecide');
    if (redo.length === 0) {
      redoStep.skip(flags.upgradeBlind
        ? 'no track tagged before it was measured has been measured since'
        : 'no tagged track is stale (same prompt and model)');
    } else {
      redoStep.start({
        runsOn: llm.machines.join(' + '),
        scope: `${F.fmtCount(redo.length)} tracks ${flags.upgradeBlind ? 'tagged before they were measured' : 'tagged with an older prompt or model'}`,
      });
      if (llm.notice) runlog.problem('warning', llm.notice);
      const tagged = await llmTagInBatches(
        redo, tagBatchSize, promptHash, 'llm', tagConsumers, { phase: 'seed' },
      );
      llmCalls += tagged.callCount;
      llmTagged += tagged.tagged;
      mergeByLeg(tagged.byLeg);
      redoStep.done(F.tagResult({ asked: redo.length, tagged: tagged.tagged, untaggable: tagged.untaggable.length, calls: tagged.callCount }));
    }
    lap('seed');
  }

  // Phase 5: ANALYZE (acoustic bpm/key/intro), the same pass as `npm run
  // analyze`. No-ops when no analysis backend is reachable, so it never blocks
  // a tag run.
  if (plan.analyze) {
    try {
      await runAnalysisPass({
        limit: flags.limit === Infinity ? undefined : flags.limit,
        reAnalyze: flags.reAnalyze,
        rescan: flags.rescan,
        // Tri-state; undefined defers to settings.audio.vocalActivity / env.
        vocalBackfill: flags.vocal ? true : flags.noVocal ? false : undefined,
      });
    } catch (err: any) {
      runlog.problem('warning', `The audio analysis stopped (the next run retries): ${F.failureReason(String(err?.message || err))}`);
    }
  }
  // The analysis writes measurements, CLAP vectors and audio-corrected
  // energies, never moods; the re-vote below rewrites propagated tags, so it
  // waits for the self-check.
  const checked = await selfCheck;
  if (overlap && plan.forwardTag) reportSelfCheck(checked, selfCheckAt, true);
  lap('analyze');

  // Phase 5 measures the tracks phase 1 just embedded, so their Sound: words
  // land after their vectors and mark them dirty (#2236). Re-embed only the
  // marked rows now, so a new track gets its Sound: line in the run that
  // analysed it. Best-effort: a failure leaves the marks for the next run.
  if (plan.forwardTag && plan.analyze) {
    let rebuilt: string[] = [];
    try {
      rebuilt = await phaseEmbed([], tagBatchSize, textMode, runlog.step('refresh'), 'marked');
    } catch (err) {
      runlog.problem('warning', `Refreshing the analysed tracks' similarity vectors failed (the next run retries): ${err?.message || err}`);
    }
    lap('embed');

    // Phases 3-4 voted this run's new tracks over their first vectors, which had
    // no Sound: line yet. Vote again for the ones that took a propagated tag in
    // this run and whose vectors were just rebuilt, over the vectors they will
    // keep (#2313). Never an llm or manual row, never one tagged in an earlier
    // run, and a vote that no longer clears the bar keeps the first one.
    const revote = rebuilt.filter(id => propagatedThisRun.has(id) && db.getTrack(id)?.source === 'propagated');
    if (revote.length > 0) {
      try {
        let changed = 0;
        for (const id of revote) {
          const result = voteForTrack(id);
          if (result.votingNeighbours < 1 || result.confidence < confidenceThreshold || result.moods.length === 0) continue;
          db.upsertTrackTags(id, {
            moods: result.moods,
            energy: result.energy,
            source: 'propagated',
            confidence: result.confidence,
            promptHash,
            model: modelLabel,
          });
          changed += 1;
        }
        runlog.note(F.redoneFromSimilarLine(changed, revote.length));
        // The vote rewrote their energy, so the audio pass runs over it again,
        // with the operator's switches: a re-vote that leaves a row without an
        // energy gets it filled now, not at the next run.
        if (changed > 0) runAudioEnergyPass(audioEnergyOptions(settings.get()));
      } catch (err: any) {
        runlog.problem('warning', F.redoneFromSimilarFailed(String(err?.message || err)));
      }
      lap('propagate');
    }
  }

  finish(llmCalls, llmTagged, byLeg, timings);
}

function autoSeedCount(librarySize: number): number {
  // ~4% of the library, floored at 200 and capped at 2500; propagation carries
  // the rest. MIRROR: web/components/admin/LibraryTaggingModal.tsx `seedBudget`
  // replicates this for the Run-tab cost preview — keep the constants in sync.
  return Math.max(200, Math.min(2500, Math.round(librarySize * 0.04)));
}

// The self-check's step, reported once its result is in (it may have run
// alongside the analysis).
function reportSelfCheck(r: SelfCheckResult | null, at: number, alongside: boolean): void {
  const st = runlog.step('selfcheck');
  if (!r) return;
  if ('skipped' in r) {
    st.skip(r.skipped);
    return;
  }
  st.start({ runsOn: `${LOCAL_WHERE} (reads only)`, scope: F.selfCheckScope(), at });
  // Beside the analysis, the wall time since it began is the analysis's: the
  // step gives its own work time.
  const timing = alongside ? { ms: r.workMs, alongside: 'the analysis' } : {};
  if ('failed' in r) st.done({ summary: r.failed, outcome: 'partial', ...timing });
  else st.done({ summary: r.summary, ...timing });
}

function finish(
  llmCalls: number,
  llmTagged: number,
  byLeg: Record<string, number>,
  timings: Record<string, number> = {},
) {
  // Machine-readable timings for the panel, keyed by phase as before.
  const timed = sortedPhaseTimings(timings);
  reportProgress({
    phase: 'done',
    label: 'Finished',
    done: llmTagged,
    llm: Object.keys(byLeg).length ? { legs: byLeg } : undefined,
    timings: timed.length ? Object.fromEntries(timed) : undefined,
  });
  const legs = Object.entries(byLeg);
  if (legs.length > 1) runlog.debug(`per LLM: ${legs.map(([m, n]) => `${m}=${n}`).join(' · ')}`);
  // One closing block; a full per-genre/per-mood breakdown would bury it.
  const s: any = db.stats();
  runlog.runLog.finish({
    headline: `${F.fmtCount(llmTagged)} tracks tagged by the LLM (${F.fmtCount(llmCalls)} LLM call${llmCalls === 1 ? '' : 's'})`,
    library: F.librarySummary({
      tagged: s.total ?? 0,
      moods: Object.keys(s.byMood || {}).length,
      genres: Object.keys(s.byGenre || {}).length,
      embedded: s.withEmbedding ?? 0,
      bySource: s.bySource || {},
    }),
  });
}

// Exit explicitly: analyzer.ts's local backend is a persistent stdio child that
// keeps the event loop alive, so a completed run would otherwise hang the CLI.
main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
