// Audio-derived energy from the mood cosines the analyzer heard (#1362), in two
// steps over one library-wide yardstick:
// 1. CORRECT a propagated energy: inherited from embedding neighbours, so it is
//    overruled where the audio is DECISIVE (audioEnergy returns null for the
//    ambiguous middle, which leaves the inherited value alone).
// 2. FILL an empty energy on any tagged row but an operator's: the tagging
//    model may answer moods with no energy, and an empty energy drops the track
//    from every show with strict filters. With no value to protect, the middle
//    band is 'medium' (audioEnergyFill). An energy that IS there, from the LLM
//    or the operator, is never touched by either step.
// Moods are not corrected the same way: a mood is editorial.

import * as db from './library-db.js';
import { audioEnergy, audioEnergyFill, computeBaselines, prunedBaselines } from './audio-calibration.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-energy');

export interface PropagatedEnergyStats {
  scope: number;      // propagated tracks carrying audio scores
  corrected: number;  // rows whose energy the audio actually changed
  agreed: number;     // rows where the audio confirmed the propagated value
  undecided: number;  // rows where the audio had no decisive answer
  fillScope: number;  // tagged rows with audio scores and no energy at all
  filled: { high: number; medium: number; low: number }; // empty energies given one
  skipped: string | null;
}

const fmt = (n: number) => n.toLocaleString('en-GB');

// Writes `energy` ONLY: source and moods stay as tagging left them, so a
// propagated row keeps reporting inherited moods and an LLM row its own.
export function runPropagatedEnergyPass(): PropagatedEnergyStats {
  const noFill = { high: 0, medium: 0, low: 0 };
  const empty = { scope: 0, corrected: 0, agreed: 0, undecided: 0, fillScope: 0, filled: noFill };

  const rows = db.propagatedTracksWithAudioScores();
  // Read before the correction writes: a propagated row with no energy that
  // the audio settles is the correction's, and the fill re-reads afterwards.
  const anyEmpty = db.emptyEnergyTracksWithAudioScores().length > 0;
  if (rows.length === 0 && !anyEmpty) {
    return { ...empty, skipped: 'no propagated or empty-energy tracks with audio scores' };
  }

  // Baselines come from the WHOLE library, never the propagated subset (that
  // would be a biased yardstick). Pruned per mood: too few scores gives a
  // near-degenerate sd that swings the axis on noise.
  const baselines = prunedBaselines(
    computeBaselines(
      (function* () {
        for (const row of db.iterateAudioMoodScores()) yield row.scores;
      })(),
    ),
  );
  if (!baselines) {
    return { ...empty, scope: rows.length, skipped: 'library too small to calibrate against' };
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

  const fillRows = db.emptyEnergyTracksWithAudioScores();
  const fills: Array<{ id: string; energy: 'high' | 'medium' | 'low' }> = [];
  for (const row of fillRows) {
    const energy = audioEnergyFill(row.scores, baselines);
    if (energy) fills.push({ id: row.id, energy });
  }
  const filled = { ...noFill };
  if (db.fillEmptyTrackEnergyBulk(fills) > 0) {
    // Counted from what is stored now, so a row a tag answer took first is
    // not reported as filled.
    for (const f of fills) if (db.getTrack(f.id)?.energy === f.energy) filled[f.energy] += 1;
  }
  const filledTotal = filled.high + filled.medium + filled.low;

  const parts = [
    `Audio-derived energy over ${fmt(rows.length)} propagated tracks — ` +
      `${fmt(updates.length)} corrected, ${fmt(agreed)} confirmed, ` +
      `${fmt(undecided)} left as-is (audio not decisive)`,
  ];
  if (fillRows.length > 0) {
    parts.push(
      `${fmt(filledTotal)} of ${fmt(fillRows.length)} empty energies filled from the audio ` +
        `(${fmt(filled.high)} high, ${fmt(filled.medium)} medium, ${fmt(filled.low)} low)`,
    );
  }
  logEvent('success', parts.join('; '));

  return {
    scope: rows.length,
    corrected: updates.length,
    agreed,
    undecided,
    fillScope: fillRows.length,
    filled,
    skipped: null,
  };
}
