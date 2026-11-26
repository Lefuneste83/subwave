// Where a track's main part starts and ends, from its measured bars (the
// `structure` facet, library-db/structure.ts). Pure: the stored per-bar
// arrays in, bar numbers out (1-based, bar 1 = the first bar line of the
// track's own beat grid).
//
// Why: the operator's DJ recipe for a transition between two tracks on one
// grid. The outgoing track leaves after its LAST hard kick plus N bars; the
// incoming one enters N bars before its FIRST hard kick, with its bass punched
// in on that kick. The phrases count from those kicks, never from bar 1
// (music/phrase-mix-policy.ts says why). Only a Hot Mix show with its opt-in
// `phraseMix` reads this: with the facet never run, or the switch off,
// nothing a station plays changes.
//
// The rules, ported from the offline prototype the operator validated by ear
// (scratch/onair/trim/structure.py):
//   - a FULL bar is a full section: hard kick (kick level >= HARD_KICK_DB),
//     bass present (measured > FULL_BASS_DB: stored >= it), mids (>= FULL_MID_DB) and a kick on at
//     least FULL_MIN_KICKS beats. Up to FILL_BARS non-full bars between two
//     full ones are a fill and count as full; three in a row break the run. A
//     producer's drum fill at the end of a phrase is often two bars long (the
//     kick dropped 7-11 dB): a one-bar tolerance split such a track's main
//     sections into runs of 14-15 bars, none long enough to count, and put its
//     first hard kick after the last breakdown, minutes into the record.
//   - the full section starts at the first run of >= FULL_RUN_BARS full bars
//     (`fullSectionStart`), and ends at the last bar of the last such run
//     (`lastHardKick`). `firstFullPhrase` is the first bar of the first run of
//     at least a phrase (PHRASE_BARS) of full bars, which may be a shorter
//     groove before the full section: a phrase-mix entry never skips a
//     phrase of it (music/phrase-mix-policy.ts).
//   - the first hard kick is where the kick RETURNS: the bar after the last
//     dip (>= DIP_MIN_BARS consecutive bars with the kick below HARD_KICK_DB)
//     within the DIP_LOOKBACK_BARS bars before the full section; with no such
//     dip it is the full section's first bar. A 1-2 bar fill is no dip. On a
//     track whose kick lands before its mids fill out (a long build), this
//     puts the hard kick where a DJ hears it, not where the arrangement fills.
//   - intro = the bars before the first hard kick, outro = the bars after the
//     last one.
// The levels are dB against the track's own loud bars (90th percentile), so
// the thresholds read the same on a quiet master and a loud one. A stored
// level is the 0.5 dB step at or below the measurement (the worker floors it),
// so `>=` a threshold on the 0.5 dB grid is exact, and "bass above -12 dB"
// reads as a stored step >= -12 (a measurement of exactly -12.0 aside).

export const HARD_KICK_DB = -4;
export const FULL_BASS_DB = -12;
export const FULL_MID_DB = -5.5;
export const FULL_MIN_KICKS = 3;
export const FULL_RUN_BARS = 16;
export const FILL_BARS = 2;
export const DIP_LOOKBACK_BARS = 24;
export const DIP_MIN_BARS = 4;
export const PHRASE_BARS = 8;
// A bar whose whole band sits this far below the loud bars is silent (the
// prototype's test; stored as `level`).
export const SILENT_DB = -35;

export const isSilentBar = (level: number): boolean => level < SILENT_DB;

// The per-bar arrays the rules read (library-db/structure.ts StructureBars).
export interface StructureRuleInput {
  kick: readonly number[];   // kick level, dB vs the loud bars
  kicks: readonly number[];  // beats of the bar with a kick hit
  bass: readonly number[];   // 40-120 Hz between the kicks, dB
  mid: readonly number[];    // 250 Hz-4 kHz, dB
}

export interface StructurePoints {
  bars: number;
  fullSectionStart: number | null;
  firstHardKick: number | null;
  lastHardKick: number | null;
  firstFullPhrase: number | null;
  introBars: number | null;
  outroBars: number | null;
}

const barCount = (b: StructureRuleInput) => Math.min(b.kick.length, b.kicks.length, b.bass.length, b.mid.length);

// Full-section bars, the fill tolerance applied: a gap of at most FILL_BARS
// non-full bars with a full bar on each side counts as full. Index i = bar i + 1.
export function fullBars(b: StructureRuleInput): boolean[] {
  const n = barCount(b);
  const raw: boolean[] = [];
  for (let i = 0; i < n; i++) {
    raw.push(b.kick[i] >= HARD_KICK_DB && b.bass[i] >= FULL_BASS_DB && b.mid[i] >= FULL_MID_DB && b.kicks[i] >= FULL_MIN_KICKS);
  }
  const full = raw.slice();
  for (let i = 0; i < n;) {
    if (raw[i]) { i++; continue; }
    let j = i;
    while (j < n && !raw[j]) j++;
    if (i > 0 && j < n && j - i <= FILL_BARS) full.fill(true, i, j);
    i = j;
  }
  return full;
}

// Runs of >= `min` full bars, as [first, last] indices (0-based).
function fullRuns(full: readonly boolean[], min: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < full.length;) {
    if (!full[i]) { i++; continue; }
    let j = i;
    while (j < full.length && full[j]) j++;
    if (j - i >= min) runs.push([i, j - 1]);
    i = j;
  }
  return runs;
}

export function structurePoints(b: StructureRuleInput): StructurePoints {
  const n = barCount(b);
  const full = fullBars(b);
  const runs = fullRuns(full, FULL_RUN_BARS);
  if (!runs.length) {
    return { bars: n, fullSectionStart: null, firstHardKick: null, lastHardKick: null, firstFullPhrase: null, introBars: null, outroBars: null };
  }
  const main = runs[0][0];
  // The dips (kick below the hard level) in the look-back window, as runs.
  const dips: Array<[number, number]> = [];
  for (let i = Math.max(0, main - DIP_LOOKBACK_BARS); i < main; i++) {
    if (!(b.kick[i] < HARD_KICK_DB)) continue;
    const last = dips[dips.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else dips.push([i, i]);
  }
  const real = dips.filter(([a, z]) => z - a + 1 >= DIP_MIN_BARS);
  const first = real.length ? real[real.length - 1][1] + 1 : main;
  const last = runs[runs.length - 1][1];
  return {
    bars: n,
    fullSectionStart: main + 1,
    firstHardKick: first + 1,
    lastHardKick: last + 1,
    firstFullPhrase: fullRuns(full, PHRASE_BARS)[0][0] + 1,
    introBars: first,
    outroBars: n - 1 - last,
  };
}

// The phrase start (bars 1, 9, 17, …) nearest `bar`, the earlier one on a
// tie; within the track when `bars` is given.
export function snapToPhraseStart(bar: number, bars?: number): number {
  const k = Math.max(0, Math.ceil((bar - 1) / PHRASE_BARS - 0.5));
  let s = 1 + k * PHRASE_BARS;
  if (bars != null) while (s > bars && s > 1) s -= PHRASE_BARS;
  return s;
}

// The phrase end (bars 8, 16, 24, …) nearest `bar`, the earlier one on a tie,
// never before the first; within the track when `bars` is given (a track
// shorter than one phrase: its last bar).
export function snapToPhraseEnd(bar: number, bars?: number): number {
  const k = Math.max(1, Math.ceil(bar / PHRASE_BARS - 0.5));
  let e = k * PHRASE_BARS;
  if (bars != null) {
    while (e > bars && e > PHRASE_BARS) e -= PHRASE_BARS;
    if (e > bars) e = bars;
  }
  return e;
}

// Where bar `bar` (1-based) starts, ms, through the stored runs
// ([startMs, barUs, count]: `count` equal bars from `startMs`). null outside.
export function barStartMs(runs: ReadonlyArray<readonly [number, number, number]>, bar: number): number | null {
  if (!Number.isInteger(bar) || bar < 1) return null;
  let i = bar - 1;
  for (const [start, barUs, count] of runs) {
    if (i < count) return start + (i * barUs) / 1000;
    i -= count;
  }
  return null;
}
