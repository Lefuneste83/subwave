// Phase 1 - embedding. Turns each track's metadata and enrichment into the text
// vector the picker's similarity search runs over. See ../tag-library.ts.

import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import * as settings from '../../settings.js';
import { resolveEraYear } from '../show-filter.js';
import { reportProgress } from '../tagger-progress.js';
import * as runlog from '../run-log.js';
import * as F from '../run-log-format.js';
import { embeddingsWhere } from '../run-log-where.js';

// The embedding preflight both CLIs run before they embed (#2313): a provider is
// configured, and a real probe answers. The probe's measured dimension beats the
// name→dim guess (#174, #319).
export type EmbeddingPreflight = { ok: true; dim: number } | { ok: false; message: string };

export async function embeddingPreflight(): Promise<EmbeddingPreflight> {
  if (!embeddings.isAvailable()) {
    return { ok: false, message: 'Embeddings not available — set settings.embedding.enabled / provider' };
  }
  const probe = await embeddings.ensureReady();
  if (probe.code !== 'ok') {
    return { ok: false, message: `Embedding preflight failed (${probe.code}): ${probe.message}` };
  }
  return { ok: true, dim: probe.dim ?? embeddings.resolveEmbeddingDim() };
}

// The task-prefix mode a run embeds documents in. A reseed re-embeds everything,
// so it adopts the active model's preferred mode; otherwise stay consistent with
// the stored vectors, since query embeds must match the documents (a legacy meta
// row with no mode = embedded bare).
export function indexTextMode(reseed = false): embeddings.IndexTextMode {
  return reseed
    ? embeddings.preferredTextMode()
    : embeddings.resolveIndexTextMode(db.getEmbeddingMeta()?.textMode, db.vectorCount());
}

// The standalone Analyse run's trailing re-embed (#2313), so a new track's Sound:
// line does not wait for the next tag run. Dirty rows only, as the tag run's own
// trailing pass: never the unembedded rows phaseEmbed also takes. `before` is the
// dirty set read before the analysis, and a run that marked nothing embeds nothing
// and never probes the provider; one that marked something also takes the marks
// already waiting (an operator's, an era edit's), which cost the same either way.
// Only into the index as it stands: the same model and dimension as the stored
// vectors, or the run leaves its marks for the tag run, which owns a model change.
// Once, with no retry of its own (the default provider is a slow homelab Ollama),
// and best-effort: any failure logs and keeps the marks.
export async function reembedNewlyMarked(
  before: ReadonlySet<string>,
  step: runlog.Step = runlog.step('refresh', F.STEP_TITLE.refresh),
): Promise<string[]> {
  const marked = db.textVectorDirtyIds();
  if (!marked.some(id => !before.has(id))) {
    step.skip('no analysed track changed its sound description');
    return [];
  }
  const meta = db.getEmbeddingMeta();
  if (!meta) {
    step.skip('there is no similarity index yet');
    return [];
  }
  const leftFor = (why: string) =>
    step.skip(`${F.fmtCount(marked.length)} similarity vectors left for the next tag run: ${why}`);
  const modelChanged = () => leftFor(`the embedding model changed since the index was built (${meta.model}, dim=${meta.dim})`);
  try {
    // The model is compared before the probe, so a run on another model sends
    // nothing, and never has ensureReady() pull a model it would then refuse.
    if (embeddings.isAvailable() && embeddings.activeModelLabel() !== meta.model) {
      modelChanged();
      return [];
    }
    const pre = await embeddingPreflight();
    if (!pre.ok) {
      leftFor(pre.message);
      return [];
    }
    if (pre.dim !== meta.dim) {
      modelChanged();
      return [];
    }
    // The tag run's batch rule (tag-library.ts tagBatchSize).
    const batchSize = Math.max(1, Math.min(50, (settings.get() as any).embedding?.batchSize ?? 25));
    return await embedIds(marked, batchSize, indexTextMode(), step, 'marked');
  } catch (err: any) {
    runlog.problem('warning', `Refreshing the analysed tracks' similarity vectors failed (the next run retries): ${F.shortenAnalyzerMessage(String(err?.message || err))}`);
    step.skip('stopped by an error');
    return [];
  }
}

// Returns the ids whose vectors it wrote, so a caller can act on just those.
export async function phaseEmbed(
  targetIds: string[],
  batchSize: number,
  // The index's task-prefix mode, resolved once in run(): every document this
  // phase writes must match the vectors already in the index.
  textMode: embeddings.IndexTextMode,
  // The run-log step it reports as: the forward embed, the trailing refresh
  // of the analysed tracks, or a re-scan's rebuild.
  step: runlog.Step = runlog.step('embed', `Build similarity vectors with ${embeddings.activeModelLabel()}`),
  kind: 'new' | 'marked' | 'rebuild' = 'new',
): Promise<string[]> {
  // A dirty vector stays searchable until this pass replaces it, so it is
  // included even though hasVector(id) is true.
  const needsEmbed: string[] = db.textVectorDirtyIds();
  for (const id of targetIds) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Already-tagged tracks with no vector yet (legacy v1 imports) can't anchor
  // the KNN graph without this.
  for (const id of db.allTaggedIds()) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  const unique = [...new Set(needsEmbed)];
  if (unique.length === 0) {
    step.skip(kind === 'marked' ? 'no analysed track changed its sound description' : 'every track already has one');
    return [];
  }
  return embedIds(unique, batchSize, textMode, step, kind);
}

async function embedIds(
  unique: string[],
  batchSize: number,
  textMode: embeddings.IndexTextMode,
  step: runlog.Step,
  kind: 'new' | 'marked' | 'rebuild',
): Promise<string[]> {
  const written: string[] = [];
  step.start({ runsOn: embeddingsWhere(), scope: F.embedScope({ tracks: unique.length, pool: db.trackCount(), kind }) });
  reportProgress({ phase: 'embed', label: 'Embedding tracks', done: 0, total: unique.length });

  const embedBatchSize = Math.max(8, Math.min(64, batchSize * 2));
  for (let i = 0; i < unique.length; i += embedBatchSize) {
    const batch = unique.slice(i, i + embedBatchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    const eraYears = songs.map(t =>
      resolveEraYear(t.year, t.originalYear, t.yearUntrusted),
    );
    // Measured acoustics only (#1246), through the one mapping.
    const acoustics = songs.map(t => embeddings.trackAcoustics(t));
    const texts = songs.map((t, index) =>
      embeddings.formatTrackText(
        {
          title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres,
          // Era precedence lives in ONE place (show-filter, #842), never raw year.
          eraYear: eraYears[index],
        },
        { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
        acoustics[index],
      ),
    );
    let vecs: number[][];
    try {
      vecs = await embeddings.embedDocTexts(texts, textMode);
    } catch (err: any) {
      runlog.problem('error', F.embeddingFailedProblem(embeddingsWhere(), String(err?.message || err)));
      step.done({ summary: `stopped after ${F.fmtCount(i)} of ${F.fmtCount(unique.length)}`, outcome: 'failed' });
      throw err;
    }
    for (let j = 0; j < songs.length; j++) {
      db.upsertTrackVector(songs[j].id, vecs[j], eraYears[j], embeddings.soundWords(acoustics[j]));
      written.push(songs[j].id);
    }
    if ((i + batch.length) % 500 === 0 || i + batch.length === unique.length) {
      if (i + batch.length < unique.length) step.progress(i + batch.length, unique.length);
      reportProgress({ phase: 'embed', label: 'Embedding tracks', done: i + batch.length, total: unique.length });
    }
  }
  step.done({ summary: `${F.fmtCount(written.length)} vector${written.length === 1 ? '' : 's'} ${kind === 'new' ? 'built' : 'rebuilt'}` });
  return written;
}
