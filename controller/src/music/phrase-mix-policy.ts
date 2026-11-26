// The phrase mix (a Hot Mix show's `phraseMix`): where a beat-mixed transition
// sits, read from both tracks' measured structure (the `structure` facet,
// music/structure-policy.ts). Pure: the structure points and bar times in, a
// window (or the reason there is none) out. music/hot-mix-seam.ts then plans
// the seam on that window, and queue.planHotMixSeam searches the seam as
// before whenever either says no.
//
// The recipe (the operator's, mix-design §2k; it won three blind listening
// tests out of three). The transition starts where the outgoing track's outro
// starts, the bar after its LAST hard kick, and lasts L bars. The incoming
// track enters L bars before its FIRST hard kick, so that kick lands exactly
// where the transition ends and the outgoing track is cut: the new record's
// full section takes over on its own downbeat, the old one's leaves with its
// energy already gone. L is the show's `phraseBars` (8 the norm, 16 fine on
// radio, up to 32), shortened a phrase at a time to what the incoming intro
// holds.
//
// Why phrases count from the kicks, never from the grid's bar 1: a producer's
// phrases run from where the arrangement turns, and the grid's first bar line
// is only where its beat tracker locked on (a pickup, a silent lead-in, a
// spoken intro). Across the library the first hard kick sits on a grid 8-bar
// line in only 42 % of tracks, so a phrase snapped to bar 1 would put the
// kick off the transition's end more often than on it.
//
// The entry never skips a main section, nor more than a DJ intro
// (incomingEntry's guards, checked once L is chosen; a refusal sends the queue
// to the searched seam, which enters within its own 30 s). It is refused when
// it lies a phrase or more past the start of the first run of at least a
// phrase of full bars (structure-policy `firstFullPhrase`): those bars are a
// main section, often a groove before the first breakdown, that the listener
// would never hear. An entry a few bars into that run only shortens it. And it
// is refused when it lies more than ENTRY_MAX_BARS of the track's
// own bars past its silence trim, timed from the trim so a beatless lead-in
// before the grid's bar 1 counts too. 56 bars is the deepest entry a 64-bar DJ
// intro asks for (8 bars before its kick): the recipe's blind tests entered
// such an intro there, skipping it is the point (it is written to be mixed, and
// the searched seam would air it alone for a minute and a half), and every
// skip up to it sits on the library's phrase-line peaks (16, 24, 32, 48 bars).
// Past it the entry no longer skips an intro but music the measure missed: an
// extended mix whose two-bar fills hid its main sections entered 4 min in, and
// the deepest aired entries skipped 3-4 min. In bars, not seconds, because the
// skips cluster on phrase lines and a seconds cap would cut through a cluster
// at a tempo-dependent point.
//
// The outgoing side moves back whole phrases, still counted from its last
// hard kick, when its effective end (trim, cap) comes before the transition
// does, but never back into the bars where its full section starts, nor before
// its own cue-in. The incoming side never enters before its silence trim.
//
// The bass move the recipe goes with (the incoming bass held at its pot's
// minimum until it swaps in on its first hard kick, music/bass-pot-policy.ts)
// is the mixer's work: this only says where the bars are.
import { barStartMs, PHRASE_BARS, structurePoints, type StructurePoints } from './structure-policy.js';
import type { StructureBars, StructureStatus } from './library-db/structure.js';
import { HOT_MIX_PHRASE_BARS } from '../schemas/show.js';

type Runs = ReadonlyArray<readonly [number, number, number]>;

// The deepest an entry may lie past the incoming track's silence trim, in its
// own bars: a 64-bar intro entered 8 bars before its first hard kick.
export const ENTRY_MAX_BARS = 56;

// One track's stored structure row (library-db/structure.ts getStructure), or
// as much of it as this reads.
export interface StoredStructure { status: StructureStatus; gridAt: string | null; bars: StructureBars | null }

export type PhraseStructure =
  | { ok: true; points: StructurePoints; runs: StructureBars['runs'] }
  | { ok: false; why: 'not-measured' | 'older-grid' };

// Whether a track's structure can place a phrase window on the grid the seam
// plans on (`gridMeasuredAt`, track_grid.measured_at): measured ('ok'), its
// bars readable, and measured on THAT grid, since bars measured on an older
// one would put the window off its downbeats. The queue's check for each side
// (queue.phraseWindowOf) and the Transitions count's.
export function phraseStructureOf(st: StoredStructure | null | undefined, gridMeasuredAt: string): PhraseStructure {
  if (st?.status !== 'ok' || !st.bars) return { ok: false, why: 'not-measured' };
  if (st.gridAt !== gridMeasuredAt) return { ok: false, why: 'older-grid' };
  return { ok: true, points: structurePoints(st.bars), runs: st.bars.runs };
}

// The outgoing side of a phrase window needs a full section to leave after.
export function canLeaveOnPhrase(p: StructurePoints): p is StructurePoints & { lastHardKick: number; fullSectionStart: number } {
  return p.lastHardKick != null && p.fullSectionStart != null;
}

// Whether the incoming side can enter on a phrase at best: planPhraseWindow's
// own incoming check before any silence trim, at the longest phrase a show can
// ask for (the shallowest entry). A shorter phrase enters deeper, so a show
// with one may still be refused on depth.
export function canEnterOnPhrase(p: StructurePoints, runs: Runs): boolean {
  return incomingEntry(p, runs, HOT_MIX_PHRASE_BARS[HOT_MIX_PHRASE_BARS.length - 1], 0).ok;
}

export interface PhraseSide {
  points: StructurePoints;
  runs: Runs;          // the stored bars' [startMs, barUs, count] runs
  cueInSec: number;    // where the track starts (its trim)
}

export interface PhraseInput {
  bars: number;                              // the show's phraseBars
  a: PhraseSide & { endSec: number };        // the outgoing track, its effective end
  b: PhraseSide;                             // the incoming track
}

// Bars are 1-based, as structure-policy numbers them; seconds are FILE seconds.
export interface PhraseWindow {
  bars: number;          // L, the transition's length
  aStartBar: number;     // the outgoing bar the transition starts on
  aStartSec: number;
  aCutSec: number;       // the start of bar aStartBar + L: where A is cut
  bEntryBar: number;     // the incoming bar it enters on
  bEntrySec: number;
  bPunchBar: number;     // its first hard kick, where the transition ends
  bPunchSec: number;
}

export type PhraseVerdict = { ok: true; window: PhraseWindow } | { ok: false; reason: string };

const EPS_SEC = 1e-6;
const sec = (ms: number) => Math.round(ms * 10) / 10_000;

// Where bar `bar` starts, ms; the bar line just after the last stored bar is
// that bar's end (a cut on the track's last bar line).
function barLineMs(runs: Runs, bar: number): number | null {
  const start = barStartMs(runs, bar);
  if (start != null) return start;
  const total = runs.reduce((n, r) => n + r[2], 0);
  if (bar !== total + 1 || !runs.length) return null;
  const [s, barUs, count] = runs[runs.length - 1];
  return s + (count * barUs) / 1000;
}

// How long the grid's first `bars` bars last, ms; past the stored bars at the
// last run's bar length.
function barsSpanMs(runs: Runs, bars: number): number {
  let left = bars;
  let ms = 0;
  for (const [, barUs, count] of runs) {
    const n = Math.min(left, count);
    ms += (n * barUs) / 1000;
    left -= n;
    if (!left) return ms;
  }
  return runs.length ? ms + (left * runs[runs.length - 1][1]) / 1000 : 0;
}

type Entry = { ok: true; L: number; punch: number; punchMs: number; entryMs: number } | { ok: false; reason: string };

// The incoming side: L, the largest whole phrase up to `bars` the intro holds
// after the silence trim, and the entry L bars before the first hard kick,
// unless it skips a long stretch of the record (the header's guards).
function incomingEntry(p: StructurePoints, runs: Runs, bars: number, cueInSec: number): Entry {
  if (p.firstHardKick == null) return { ok: false, reason: 'no full section on the incoming track' };
  const punch = p.firstHardKick;
  const punchMs = barStartMs(runs, punch);
  if (punchMs == null) return { ok: false, reason: 'the incoming track\'s first hard kick is outside its bars' };

  const most = Math.floor(Math.min(bars, punch - 1) / PHRASE_BARS) * PHRASE_BARS;
  if (most < PHRASE_BARS) {
    return { ok: false, reason: `the incoming track has fewer than ${PHRASE_BARS} bars before its first hard kick` };
  }
  let L = 0;
  let entryMs = 0;
  for (let l = most; l >= PHRASE_BARS; l -= PHRASE_BARS) {
    const ms = barStartMs(runs, punch - l);
    if (ms != null && ms / 1000 >= cueInSec - EPS_SEC) {
      L = l;
      entryMs = ms;
      break;
    }
  }
  if (!L) {
    return { ok: false, reason: `the incoming track's silence trim leaves fewer than ${PHRASE_BARS} bars before its first hard kick` };
  }
  const entryBar = punch - L;
  if (p.firstFullPhrase != null && entryBar - p.firstFullPhrase >= PHRASE_BARS) {
    return { ok: false, reason: `the entry at bar ${entryBar} would skip the incoming track's full bars from bar ${p.firstFullPhrase}` };
  }
  // One bar of slack: the grid's bar 1 may sit up to a bar past the trim (a
  // pickup), and the intro still counts from there.
  const depthSec = entryMs / 1000 - Math.max(0, cueInSec);
  if (depthSec > barsSpanMs(runs, ENTRY_MAX_BARS + 1) / 1000 + EPS_SEC) {
    return { ok: false, reason: `the entry at bar ${entryBar} is ${Math.round(depthSec)}s into the incoming track (over ${ENTRY_MAX_BARS} bars)` };
  }
  return { ok: true, L, punch, punchMs, entryMs };
}

export function planPhraseWindow(input: PhraseInput): PhraseVerdict {
  const { a, b } = input;
  if (!canLeaveOnPhrase(a.points)) {
    return { ok: false, reason: 'no full section on the outgoing track' };
  }
  const entry = incomingEntry(b.points, b.runs, input.bars, b.cueInSec);
  if (!entry.ok) return entry;
  const { L, punch, punchMs, entryMs } = entry;

  // The outgoing side: from the bar after the last hard kick, a phrase back at
  // a time until the cut fits before its end.
  const lastKick = a.points.lastHardKick;
  for (let sA = lastKick + 1; sA > a.points.fullSectionStart; sA -= PHRASE_BARS) {
    const startMs = barStartMs(a.runs, sA);
    if (startMs == null || startMs / 1000 < a.cueInSec - EPS_SEC) break;
    const cutMs = barLineMs(a.runs, sA + L);
    if (cutMs == null || cutMs / 1000 > a.endSec + EPS_SEC) continue;
    return {
      ok: true,
      window: {
        bars: L,
        aStartBar: sA, aStartSec: sec(startMs), aCutSec: sec(cutMs),
        bEntryBar: punch - L, bEntrySec: sec(entryMs),
        bPunchBar: punch, bPunchSec: sec(punchMs),
      },
    };
  }
  return { ok: false, reason: `the outgoing track ends before an ${L}-bar transition fits` };
}
