// Audio-derived energy from the mood cosines the analyzer heard (#1362), over
// one library-wide yardstick, in up to three steps:
// 1. CORRECT a propagated energy (always on): inherited from embedding
//    neighbours, so it is overruled where the audio is DECISIVE (audioEnergy
//    returns null for the ambiguous middle, which leaves the value alone).
// 2. FILL an empty energy (opt-in, `embedding.audioEnergy.fillEmpty`) on any
//    tagged row but an operator's: the tagging model may answer moods with no
//    energy, and an empty energy drops the track from every show with strict
//    filters. With no value to protect, the middle band is 'medium'. That
//    includes a PROPAGATED row left empty (no voting neighbour had an energy):
//    step 1 settles it where the audio is decisive, and step 2 fills the rest,
//    the undecided middle as 'medium'.
// 3. OVERRULE an LLM energy (opt-in, `embedding.audioEnergy.overruleLlm`) where
//    the audio is STRONGLY decisive (ENERGY_OVERRULE_Z, far past step 1's
//    threshold) and says otherwise.
// An operator's energy ('manual') is never touched by any step, and every
// write is the `energy` column alone. Moods are not corrected the same way: a
// mood is editorial. The pass reports through its result; the run log words
// it (run-log-format.ts energySummary) in the step that ran it.

import * as db from './library-db.js';
import { audioEnergy, audioEnergyFill, audioEnergyOverrule, computeBaselines, prunedBaselines } from './audio-calibration.js';

export interface AudioEnergyOptions {
  fillEmpty: boolean;
  overruleLlm: boolean;
}

// The pass's options from loaded settings. load() already reads anything but
// a stored boolean as off (settings.ts), so this takes the block as it is.
export function audioEnergyOptions(s: { embedding: { audioEnergy: AudioEnergyOptions } }): AudioEnergyOptions {
  return { ...s.embedding.audioEnergy };
}

type Counts = { high: number; medium: number; low: number };

// The correction's fields are the pass's result as it was before the two
// switches existed. Each switch's fields are present only while it is on, so
// with both off (the default) an upgraded station gets the same result, its
// skip reason included, and a reader can tell "off" from "on, nothing to do".
export interface AudioEnergyStats {
  scope: number;      // propagated tracks carrying audio scores
  corrected: number;  // rows whose energy the audio actually changed
  agreed: number;     // rows where the audio confirmed the propagated value
  undecided: number;  // rows where the audio had no decisive answer
  fillScope?: number;  // fillEmpty on: tagged rows with audio scores and no energy
  filled?: Counts;     // fillEmpty on: empty energies given one, by value
  overruleScope?: number; // overruleLlm on: LLM energies with audio scores
  overruled?: number;  // overruleLlm on: LLM energies the audio replaced
  skipped: string | null;
}

// The fields of the switches that are on, from what each step did.
function switchStats(
  opts: AudioEnergyOptions,
  fillScope: number,
  filled: Counts,
  overruleScope: number,
  overruled: number,
): Partial<AudioEnergyStats> {
  return {
    ...(opts.fillEmpty ? { fillScope, filled } : {}),
    ...(opts.overruleLlm ? { overruleScope, overruled } : {}),
  };
}

// No default: every run over stored energies states its switches, so a
// call site that should honour the operator's (audioEnergyOptions) cannot
// silently run the correction alone. Off is written out where it is meant.
export function runAudioEnergyPass(opts: AudioEnergyOptions): AudioEnergyStats {
  const none: Counts = { high: 0, medium: 0, low: 0 };
  const empty = { scope: 0, corrected: 0, agreed: 0, undecided: 0 };
  const anySwitch = opts.fillEmpty || opts.overruleLlm;

  const rows = db.propagatedTracksWithAudioScores();
  // Each scope is read once. The fill's rows are read before step 1 writes,
  // so the rows step 1 settles are taken out below, and the fill's write
  // re-checks that each row is still empty.
  const emptyRows = opts.fillEmpty ? db.emptyEnergyTracksWithAudioScores() : [];
  const overruleRows = opts.overruleLlm ? db.llmEnergyTracksWithAudioScores() : [];
  if (rows.length === 0 && emptyRows.length === 0 && overruleRows.length === 0) {
    if (!anySwitch) return { ...empty, skipped: 'no propagated tracks with audio scores' };
    const idle = switchStats(opts, 0, { ...none }, 0, 0);
    return { ...empty, ...idle, skipped: 'no tracks with audio scores for this pass' };
  }

  // Baselines come from the WHOLE library, never a subset (that would be a
  // biased yardstick). Pruned per mood: too few scores gives a near-degenerate
  // sd that swings the axis on noise.
  const baselines = prunedBaselines(
    computeBaselines(
      (function* () {
        for (const row of db.iterateAudioMoodScores()) yield row.scores;
      })(),
    ),
  );
  if (!baselines) {
    return {
      ...empty,
      scope: rows.length,
      ...switchStats(opts, 0, { ...none }, 0, 0),
      skipped: 'library too small to calibrate against',
    };
  }

  const updates: Array<{ id: string; energy: string }> = [];
  let agreed = 0;
  let undecided = 0;
  for (const row of rows) {
    const derived = audioEnergy(row.scores, baselines);
    if (derived == null) {
      undecided += 1;
      continue;
    }
    if (derived === row.energy) {
      agreed += 1;
      continue;
    }
    updates.push({ id: row.id, energy: derived });
  }
  db.setTrackEnergyBulk(updates);

  // Step 2: a propagated row with no energy that step 1 settled is step 1's;
  // one step 1 left undecided stays in the fill's scope like any other.
  const settled = new Set(updates.map((u) => u.id));
  const fillRows = emptyRows.filter((r) => !settled.has(r.id));
  let filled = { ...none };
  if (fillRows.length > 0) {
    const fills: Array<{ id: string; energy: keyof Counts }> = [];
    for (const row of fillRows) {
      const energy = audioEnergyFill(row.scores, baselines);
      if (energy) fills.push({ id: row.id, energy });
    }
    filled = db.fillEmptyTrackEnergyBulk(fills);
  }

  let overruled = 0;
  if (overruleRows.length > 0) {
    const changes: Array<{ id: string; from: string; energy: string }> = [];
    for (const row of overruleRows) {
      const energy = audioEnergyOverrule(row.scores, baselines, row.energy);
      if (energy) changes.push({ id: row.id, from: row.energy, energy });
    }
    overruled = db.overruleTrackEnergyBulk(changes);
  }

  const switched = switchStats(opts, fillRows.length, filled, overruleRows.length, overruled);

  return {
    scope: rows.length,
    corrected: updates.length,
    agreed,
    undecided,
    ...switched,
    skipped: null,
  };
}
