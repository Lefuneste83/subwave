import { z } from 'zod';

// Library → Transitions: how many tracks can take each DJ Hot Mix transition,
// overall and per Hot Mix show (music/transition-readiness-policy.ts decides,
// music/transition-readiness.ts counts, GET /library/transitions serves it).

// Best case first: the incoming track enters on a phrase, synced; synced on
// the bar; the safe transition only; never picked by a Hot Mix show.
export const TRANSITION_TIER_IDS = ['phrase', 'beat', 'safe', 'out'] as const;
export type TransitionTierId = (typeof TRANSITION_TIER_IDS)[number];

// Why a track sits in its tier and not a better one.
export const TRANSITION_PART_IDS = [
  // phrase
  'phrase-both',             // leaves and enters on a phrase
  'phrase-out-only',         // leaves on a phrase; its intro holds under 8 bars
  // beat: why no phrases
  'no-full-section',         // structure measured, no 16-bar full section
  'structure-unmeasurable',  // the analyzer could not measure it (reason)
  'structure-failed',        // the measurement failed or is unreadable
  'structure-older-grid',    // measured on a grid since replaced
  'structure-not-measured',  // trusted bars, structure not measured yet
  'bars-half-bar',           // bar line on beat 1 or 3, no clear drop to decide
  'bars-held',               // the grid policy does not trust the bar line
  // safe
  'no-trusted-bars',         // no grid segment with a downbeat the seam trusts
  // out: why no Hot Mix tempo
  'grid-held',               // grid measured but not applied (held by its gate)
  'grid-reverted',           // the operator reverted the grid
  'grid-unmeasurable',       // no steady pulse, too short
  'grid-failed',             // the grid measurement failed
  'no-grid',                 // no grid measured
] as const;
export type TransitionPartId = (typeof TRANSITION_PART_IDS)[number];

const count = z.number().int().min(0);

export const transitionReadinessSchema = z.object({
  library: count,
  tiers: z.array(z.object({
    tier: z.enum(TRANSITION_TIER_IDS),
    tracks: count,
    // Of them, tracks with stems saved (tracks.stems_at).
    stems: count,
    parts: z.array(z.object({ part: z.enum(TRANSITION_PART_IDS), reason: z.string().nullable(), tracks: count })),
  })),
  shows: z.array(z.object({
    id: z.string(),
    name: z.string(),
    maxStepPct: z.number(),
    // The curve's lowest and highest tempo; null without a curve (every
    // known tempo is in reach).
    curve: z.object({ lo: z.number(), hi: z.number() }).nullable(),
    phraseMix: z.boolean(),
    // Tracks in reach per tier; the `out` tier has no Hot Mix tempo, so it is
    // never in reach (see outByStoredTempo).
    tiers: z.object({ phrase: count, beat: count, safe: count }),
    // Tracks out of Hot Mix whose stored (untrusted) tempo is in reach.
    outByStoredTempo: count,
  })),
  computedAt: z.string(),
  durationMs: z.number().min(0),
});

export const transitionReadinessResponseSchema = z.object({
  readiness: transitionReadinessSchema.nullable(),
});

export type TransitionReadiness = z.output<typeof transitionReadinessSchema>;
export type TransitionReadinessResponse = z.output<typeof transitionReadinessResponseSchema>;
