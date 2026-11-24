// Transition readiness (Library → Transitions): which Hot Mix transition each
// track can take at best, overall and per Hot Mix show. Pure: one track's
// stored facts in, its tier (and why it is not in a better one) out; the pass
// that reads every track is music/transition-readiness.ts.
//
// The operator asked for it because a phrase-analysis percentage said nothing
// about what airs. So the tiers are what the seam planner and the picker do
// with a track, asked of the modules that decide it, never restated here:
//   phrase  the seam can sit on its phrases: a Hot Mix tempo, a trusted bar
//           grid, and a structure measured on that grid with a full section
//           (phrase-mix-policy.ts phraseStructureOf + canLeaveOnPhrase, the
//           queue's own check). Only a show with its phrase mix on uses it.
//   beat    synced on the bar, not phrase-placed: a Hot Mix tempo and at least
//           one segment the seam planner trusts (hot-mix-seam.ts
//           trustedSegments: a downbeat, 8+ beats, its period the tempo's).
//   safe    a Hot Mix tempo but no trusted segment: the planner refuses every
//           seam with it and the safe transition airs (safe-out-policy.ts).
//   out     no Hot Mix tempo (hot-mix-policy.ts mixTempoOf null): never picked
//           by a Hot Mix show; it airs only in other shows.
// A seam needs both sides: a phrase mix takes two phrase tracks, so a tier is
// the best case for the track, not a promise for each of its seams.
//
// Why a beat-tier track has no phrases, in the order the structure facet
// itself decides it (library-db/structure.ts deriveStructureRow): the grid
// policy holds its bar line (no structure is measured on held bars), split
// into the half-bar case (the downbeats fall on beats 1 and 3 alike and no
// clear drop placed the bar line, grid-policy.ts) and the rest; then no
// structure measured yet, one measured on an older grid, one the analyzer
// could not measure (by its reason: odd-meter, too-long, ...), one that
// failed; and last a measured structure with no full section (no 16-bar run
// of full bars, structure-policy.ts), which nothing can phrase-mix.

import { mixTempoOf, withinCurveReach, type HotMix } from './hot-mix-policy.js';
import { trustedSegments } from './hot-mix-seam.js';
import { canEnterOnPhrase, canLeaveOnPhrase, phraseStructureOf, type StoredStructure } from './phrase-mix-policy.js';
import { GRID_WRITE_GATE, halfbarTrusted } from './grid-policy.js';
import { structureGridOf } from './library-db/structure.js';
import type { GridApplied, GridPhaseSource, GridSegment, GridStatus } from './library-db/grid.js';
import type { TransitionPartId, TransitionTierId } from '../schemas/transition-readiness.js';

export const TRANSITION_TIERS: readonly TransitionTierId[] = ['phrase', 'beat', 'safe', 'out'];

// One track's grid row, as library-db/grid.ts stores it (segments parsed).
export interface ReadinessGrid {
  status: GridStatus;
  applied: GridApplied;
  bpm: number | null;
  beatsPerBar: number | null;
  segments: GridSegment[];
  coverage: number | null;
  downbeatAgreement: number | null;
  downbeatHalfbar: number | null;
  downbeatDropDb: number | null;
  downbeatPhase: GridPhaseSource | null;
  decodedMs: number | null;
  measuredAt: string;
}

export interface ReadinessFacts {
  bpm: number | null;                  // tracks.bpm
  grid: ReadinessGrid | null;
  // `bars` may be a getter: only a phrase candidate reads it.
  structure: (StoredStructure & { reason: string | null }) | null;
}

export interface Readiness {
  tier: TransitionTierId;
  part: TransitionPartId;
  // The analyzer's own word for an unmeasurable structure.
  reason?: string | null;
  // The tempo a Hot Mix show judges it on (null in `out`).
  mixBpm: number | null;
}

function gridOutPart(g: ReadinessGrid | null): TransitionPartId {
  if (!g) return 'no-grid';
  if (g.status === 'unmeasurable') return 'grid-unmeasurable';
  if (g.status === 'failed') return 'grid-failed';
  return g.applied === -1 ? 'grid-reverted' : 'grid-held';
}

// Why a beat-tier track's structure gives no phrase (header, last paragraph).
function noPhrasePart(f: ReadinessFacts, g: ReadinessGrid): Pick<Readiness, 'part' | 'reason'> {
  if (!structureGridOf(g)) {
    // The half-bar case held for want of a clear drop; a half-bar grid whose
    // drop is clear but still held is held for its coverage, like the rest.
    const half = g.downbeatHalfbar;
    const halfBar = half != null && Number.isFinite(half) && half >= GRID_WRITE_GATE.minHalfbar && !halfbarTrusted(g);
    return { part: halfBar ? 'bars-half-bar' : 'bars-held' };
  }
  const st = f.structure;
  if (!st) return { part: 'structure-not-measured' };
  if (st.gridAt !== g.measuredAt) return { part: 'structure-older-grid' };
  if (st.status === 'unmeasurable') return { part: 'structure-unmeasurable', reason: st.reason ?? null };
  return { part: 'structure-failed' };
}

export function readinessOf(f: ReadinessFacts): Readiness {
  const g = f.grid;
  const mixBpm = mixTempoOf({ bpm: f.bpm, grid: g ? { status: g.status, applied: g.applied } : null });
  if (mixBpm == null || !g) return { tier: 'out', part: gridOutPart(g), mixBpm: null };
  // The seam planner's side, as queue.planHotMixSeam hands it the grid row.
  if (!trustedSegments({ segments: g.segments, beatsPerBar: g.beatsPerBar, bpm: g.bpm }).length) {
    return { tier: 'safe', part: 'no-trusted-bars', mixBpm };
  }
  const phrase = phraseStructureOf(f.structure, g.measuredAt);
  if (phrase.ok) {
    if (canLeaveOnPhrase(phrase.points)) {
      return { tier: 'phrase', part: canEnterOnPhrase(phrase.points) ? 'phrase-both' : 'phrase-out-only', mixBpm };
    }
    return { tier: 'beat', part: 'no-full-section', mixBpm };
  }
  return { tier: 'beat', ...noPhrasePart(f, g), mixBpm };
}

// ── Show columns ────────────────────────────────────────────────────────────

// Whether a Hot Mix tempo can ever be picked by this show: inside the step
// around its curve's lowest-to-highest tempo, octave-safe (the show editor's
// own count, hot-mix-policy.ts withinCurveReach). A show without a curve
// anchors each pick on the track before it, so every known tempo can be
// reached.
export function inShowReach(bpm: number | null, hm: HotMix): boolean {
  if (bpm == null) return false;
  return hm.curve.length ? withinCurveReach(bpm, hm) : true;
}

// ── Tallies ─────────────────────────────────────────────────────────────────

export interface PartTally { part: TransitionPartId; reason: string | null; tracks: number }
export interface TierTally { tier: TransitionTierId; tracks: number; stems: number; parts: PartTally[] }

export interface ShowTally {
  id: string;
  name: string;
  hm: HotMix;
  tiers: Record<Exclude<TransitionTierId, 'out'>, number>;
  // `out` tracks whose STORED tempo (untrusted) falls in reach: what a grid
  // run might bring in, never what the show can pick today.
  outByStoredTempo: number;
}

export function emptyShowTiers(): ShowTally['tiers'] {
  return { phrase: 0, beat: 0, safe: 0 };
}

export class ReadinessTally {
  library = 0;
  private tiers = new Map<TransitionTierId, { tracks: number; stems: number; parts: Map<string, PartTally> }>();
  constructor(readonly shows: ShowTally[]) {
    for (const t of TRANSITION_TIERS) this.tiers.set(t, { tracks: 0, stems: 0, parts: new Map() });
  }

  add(r: Readiness, o: { stems: boolean; storedBpm: number | null }): void {
    this.library++;
    const t = this.tiers.get(r.tier)!;
    t.tracks++;
    if (o.stems) t.stems++;
    const key = `${r.part}\u0000${r.reason ?? ''}`;
    const p = t.parts.get(key) ?? { part: r.part, reason: r.reason ?? null, tracks: 0 };
    p.tracks++;
    t.parts.set(key, p);
    for (const s of this.shows) {
      if (r.tier === 'out') {
        if (inShowReach(o.storedBpm != null && o.storedBpm > 0 ? o.storedBpm : null, s.hm)) s.outByStoredTempo++;
      } else if (inShowReach(r.mixBpm, s.hm)) {
        s.tiers[r.tier]++;
      }
    }
  }

  result(): TierTally[] {
    return TRANSITION_TIERS.map((tier) => {
      const t = this.tiers.get(tier)!;
      const parts = [...t.parts.values()].sort((a, b) => b.tracks - a.tracks || a.part.localeCompare(b.part)
        || (a.reason ?? '').localeCompare(b.reason ?? ''));
      return { tier, tracks: t.tracks, stems: t.stems, parts };
    });
  }
}
