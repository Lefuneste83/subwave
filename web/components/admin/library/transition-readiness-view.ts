// Library → Transitions: the words and numbers of the tab, pure (the count is
// the controller's, music/transition-readiness.ts; the rules behind each tier
// are music/transition-readiness-policy.ts). Every coded label gets plain
// words and a hover line saying what puts a track there.

import type {
  TransitionPartId, TransitionReadiness, TransitionTierId,
} from '../../../lib/schemas.generated';

export interface TierCopy {
  name: string;
  // What the listener hears at a seam of this kind.
  hears: string;
}

export const TIER_COPY: Record<TransitionTierId, TierCopy> = {
  phrase: {
    name: 'Phrase mix',
    hears: 'Beat-matched and placed on the phrases: the old track leaves after its last big kick and the new one’s first big kick lands as the old one is cut. Only in shows with the phrase mix on.',
  },
  beat: {
    name: 'Beat mix',
    hears: 'Beat-matched on the bar, the bass swapped on a downbeat, but where the blend falls in each song is searched, not placed on the phrases.',
  },
  safe: {
    name: 'Safe transition only',
    hears: 'No two beats overlap: the old track’s bass is cut on a bar line and the new one starts at full on its downbeat.',
  },
  out: {
    name: 'Not in Hot Mix',
    hears: 'Never picked by a Hot Mix show (its tempo is not trusted). It still airs in other shows, with the usual crossfade or stem blend.',
  },
};

export const SEAM_NOTE = 'Each track’s best case. A seam needs both sides: two phrase-ready tracks make a phrase mix, and the weaker side sets the seam.';

const PART_COPY: Record<TransitionPartId, { label: string; title: string }> = {
  'phrase-both': { label: 'Enters and leaves on a phrase', title: 'A full section, and a phrase entry before its first big kick that skips neither a main section nor more than a 64-bar intro.' },
  'phrase-out-only': { label: 'Leaves on a phrase, enters on the beat', title: 'Its intro holds under 8 bars before the first big kick, or entering a phrase before it would skip a main section or more than a 64-bar intro, so it enters on the beat.' },
  'no-full-section': { label: 'No full section', title: 'Structure measured, but no 16-bar run with kick, bass and mids together: nothing to place a phrase on.' },
  'structure-unmeasurable': { label: 'Structure unmeasurable', title: 'The analyzer could not measure its bars.' },
  'structure-failed': { label: 'Structure measurement failed', title: 'The structure measurement failed or could not be read; a later run tries again.' },
  'structure-older-grid': { label: 'Structure on an older grid', title: 'Measured on a beat grid since replaced: due again on the next run.' },
  'structure-not-measured': { label: 'Structure not measured yet', title: 'Its bars are trusted; the next run with a Hot Mix show measures the structure.' },
  'bars-half-bar': { label: 'Bar line ambiguous (beat 1 or 3)', title: 'Nearly every downbeat falls on beat 1 or beat 3 and no clear drop says which: the bar line is not trusted for phrases.' },
  'bars-held': { label: 'Bar line not trusted', title: 'The downbeats do not agree on one phase, or too few detected beats sit on the grid: no structure is measured on these bars.' },
  'no-trusted-bars': { label: 'No trusted bars', title: 'Its tempo is known, but no stretch of the grid has a downbeat, 8 beats or more, and a beat matching that tempo.' },
  'grid-held': { label: 'Grid held', title: 'A beat grid was measured but not applied: it disagrees with the stored tempo (double, half or another ratio), or is unsteady.' },
  'grid-reverted': { label: 'Grid reverted', title: 'You reverted its beat grid, so its tempo is not trusted.' },
  'grid-unmeasurable': { label: 'No steady beat', title: 'The analyzer found no steady pulse (too short, rubato, ambient).' },
  'grid-failed': { label: 'Grid measurement failed', title: 'The beat grid measurement failed.' },
  'no-grid': { label: 'No beat grid', title: 'No beat grid measured yet.' },
};

const REASON_WORDS: Record<string, string> = {
  'odd-meter': 'odd meter (not 4/4)',
  'too-long': 'too long (over 30 min)',
  'no-bars': 'no bar inside the audio',
  'no-grid': 'no usable grid',
  'no-whole-file-source': 'file not readable whole',
};

export function partLabel(part: TransitionPartId, reason: string | null): string {
  const base = PART_COPY[part]?.label ?? part;
  if (part !== 'structure-unmeasurable' || !reason) return base;
  return `${base}: ${REASON_WORDS[reason] ?? reason}`;
}

export function partTitle(part: TransitionPartId): string {
  return PART_COPY[part]?.title ?? '';
}

const NUM = new Intl.NumberFormat('en-GB');
export const num = (n: number) => NUM.format(n);

// One decimal, never "0.0 %" for a non-zero share.
export function pct(n: number, of: number): string {
  if (!of) return '–';
  const p = (n / of) * 100;
  if (n > 0 && p < 0.1) return '<0.1 %';
  return `${p.toFixed(1)} %`;
}

export function showRange(s: TransitionReadiness['shows'][number]): string {
  if (!s.curve) return `no curve: any tempo, ±${s.maxStepPct} % a pick`;
  const lo = Math.round(s.curve.lo * (1 - s.maxStepPct / 100));
  const hi = Math.round(s.curve.hi * (1 + s.maxStepPct / 100));
  const span = s.curve.lo === s.curve.hi ? `${s.curve.lo}` : `${s.curve.lo}–${s.curve.hi}`;
  return `${lo}–${hi} BPM (curve ${span} ±${s.maxStepPct} %)`;
}

// A show's count for one tier: null for `out` (the show never picks it).
export function showTierCount(s: TransitionReadiness['shows'][number], tier: TransitionTierId): number | null {
  return tier === 'out' ? null : s.tiers[tier];
}

export function showTotal(s: TransitionReadiness['shows'][number]): number {
  return s.tiers.phrase + s.tiers.beat + s.tiers.safe;
}

export function computedLine(r: Pick<TransitionReadiness, 'computedAt' | 'durationMs' | 'library'>, now = Date.now()): string {
  const at = Date.parse(r.computedAt);
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `Counted ${ago} over ${num(r.library)} tracks (${(r.durationMs / 1000).toFixed(1)} s); recounted when the library or a Hot Mix show changes.`;
}
