// The DJ Hot Mix bass pots (pure): how each beat-mixed seam manages its two
// basslines, the operator's rules (mix-design §2n). A DJ never plays two tracks
// with significant bass at once: two basslines at partial level beat against
// each other, the pumping a club room hides and radio does not. The crossfader
// sets the tracks' relative level; each track's own low EQ pot (radio.liq DESK
// BASS POT, a DJM-style 70 Hz shelf) manages its bass. Through the blend the
// incoming pot sits at its minimum, the incoming track entering on its mids and
// highs; the outgoing pot is tamed down to its minimum over the last
// BUILD_BARS bars, the build-up; and at the outgoing track's end, which every
// Hot Mix seam puts on an incoming bar line, the incoming pot opens to 0 in the
// mixer's 140 ms swap, just before that downbeat's kick. Chosen by blind set 8
// (mix-design §2o): the build acceptable on all three pairs, the outgoing bass
// held to the swap on none, the seam as it aired (both basses) on one.
//
// radio.liq's HOT MIX BASS MOVE reads the plan as liq_mix_bass="build" and
// liq_mix_build (output seconds) on the outgoing track and liq_mix_punch (the
// incoming track's own output seconds at the swap's downbeat) on the incoming
// one. A mixer without the pots (no `hotmix_pots`) reads only the older
// "ride", which the phrase mix alone stamps, and airs any other seam as before.

// The build-up, in bars of the overlap counted back from the swap.
export const BUILD_BARS = 8;
// The mixer's swap: 140 ms ending 10 ms before the kick. The build ends where
// the swap begins, so an overlap needs at least this before the downbeat.
export const SWAP_SEC = 0.15;

export interface BassPotPlan {
  buildSec: number;   // the outgoing pot's taming, output seconds before the swap
  punchSec: number;   // the incoming track's output seconds at the swap's downbeat
}

// `leadSec` is the overlap in output seconds and `overlapBeats` its length in
// beats of the outgoing track, whose bars are `beatsPerBar` beats. A seam
// shorter than the build tames over the whole overlap. Null when the overlap
// cannot hold the swap or its length is unknown: the seam airs as it did.
export function planBassPots(seam: { leadSec: number; overlapBeats: number; beatsPerBar: number | null }): BassPotPlan | null {
  const { leadSec, overlapBeats, beatsPerBar } = seam;
  if (!Number.isFinite(leadSec) || leadSec <= SWAP_SEC) return null;
  if (!Number.isFinite(overlapBeats) || overlapBeats <= 0) return null;
  const perBar = beatsPerBar != null && Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
  const barSec = leadSec * perBar / overlapBeats;
  const buildSec = Math.min(BUILD_BARS * barSec, leadSec - SWAP_SEC);
  return { buildSec: Math.round(buildSec * 1e4) / 1e4, punchSec: Math.round(leadSec * 1e4) / 1e4 };
}
