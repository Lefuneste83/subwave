// The hard-kick and phrase rules over a track's measured bars
// (music/structure-policy.ts; the `structure` facet's stored arrays). Pure:
// synthetic arrays only. Pinned:
//   - a full-section bar needs a hard kick, bass, mids and a kick on most
//     beats; up to two non-full bars between two full ones are a fill, not a
//     gap (a producer's two-bar drum fill), three are a gap;
//   - the full section is the first run of >= 16 full bars, and the first hard
//     kick moves back to where the kick returns after the last dip of >= 4
//     bars in the 24 bars before it (a 1-2 bar fill is no dip);
//   - the operator's reference track: first hard kick at bar 65;
//   - a kick at full strength from bar 1;
//   - no full run at all: no points;
//   - the first run of a phrase (8) of full bars, which may come before the
//     full section;
//   - phrase snapping (8-bar phrases counted from bar 1) and the bar -> ms map.
// Run: `npm test -- structure-policy`.

import test from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../src/music/structure-policy.js');

type Bars = { kick: number[]; kicks: number[]; bass: number[]; mid: number[] };

// n bars of a full section (kick 0 dB on 4 beats, bass -3 dB, mids -2 dB).
const full = (n: number): Bars => ({
  kick: Array(n).fill(0), kicks: Array(n).fill(4), bass: Array(n).fill(-3), mid: Array(n).fill(-2),
});
// Set bars [from, to] (1-based, inclusive) of one array to v.
function set(b: Bars, key: keyof Bars, from: number, to: number, v: number): Bars {
  for (let i = from; i <= to; i++) b[key][i - 1] = v;
  return b;
}

test('the constants are the approved ones', () => {
  assert.equal(P.HARD_KICK_DB, -4);
  assert.equal(P.FULL_BASS_DB, -12);
  assert.equal(P.FULL_MID_DB, -5.5);
  assert.equal(P.FULL_MIN_KICKS, 3);
  assert.equal(P.FULL_RUN_BARS, 16);
  assert.equal(P.DIP_LOOKBACK_BARS, 24);
  assert.equal(P.DIP_MIN_BARS, 4);
  assert.equal(P.PHRASE_BARS, 8);
  assert.equal(P.SILENT_DB, -35);
  assert.equal(P.isSilentBar(-35.5), true);
  assert.equal(P.isSilentBar(-35), false);
});

test('a full bar needs all four conditions; a gap of up to two bars is tolerated, three are not', () => {
  const b = full(11);
  set(b, 'kick', 2, 2, -4.5);   // soft kick
  set(b, 'bass', 4, 4, -12.5);  // no bass (stored step below -12)
  set(b, 'mid', 6, 6, -6);      // thin mids
  set(b, 'kicks', 8, 10, 2);    // kick on two beats only, three bars running
  assert.deepEqual(P.fullBars(b), [true, true, true, true, true, true, true, false, false, false, true]);
  // Two bars running (a two-bar drum fill, the kick 7 dB down) are a fill.
  assert.deepEqual(P.fullBars(set(full(6), 'kick', 3, 4, -7)), Array(6).fill(true));
  assert.equal(P.FILL_BARS, 2);
  // At the thresholds exactly: kick -4, mid -5.5 and bass -12 are full, kicks
  // 3 too (stored levels are the 0.5 dB step at or below the measurement, so
  // a stored -12 is a measurement in [-12, -11.5): above -12).
  const edge = set(set(set(set(full(3), 'kick', 2, 2, -4), 'mid', 2, 2, -5.5), 'kicks', 2, 2, 3), 'bass', 2, 2, -12);
  assert.deepEqual(P.fullBars(edge), [true, true, true]);
  // The ends are never bridged.
  assert.deepEqual(P.fullBars(set(full(3), 'kick', 1, 1, -9)), [false, true, true]);
});

test('the reference track: the hard kick is bar 65', () => {
  // Kick at full strength 1-28, -7 dB 29-32, full 33-56, -7 dB 57-60,
  // -14 dB 61-64, full from 65 with a 2-bar -7 dB fill at 79-80. Mids -6/-7
  // until 64, >= -5 from 65. So the first full RUN starts at 65 (the fill is
  // bridged), and the kick returned there after its last real dip (57-64).
  const n = 160;
  const b = full(n);
  set(b, 'kick', 29, 32, -7);
  set(b, 'kick', 57, 60, -7);
  set(b, 'kick', 61, 64, -14);
  set(b, 'kick', 79, 80, -7);
  for (let i = 1; i <= 64; i++) b.mid[i - 1] = i % 2 ? -6 : -7;
  set(b, 'mid', 65, n, -5);
  set(b, 'kick', 145, n, -20); // an outro without the kick
  const s = P.structurePoints(b);
  assert.equal(s.bars, n);
  assert.equal(s.fullSectionStart, 65);
  assert.equal(s.firstHardKick, 65);
  assert.equal(s.firstFullPhrase, 65);
  assert.equal(s.lastHardKick, 144);
  assert.equal(s.introBars, 64);
  assert.equal(s.outroBars, 16);
  assert.equal(P.snapToPhraseStart(s.firstHardKick!, n), 65);
  assert.equal(P.snapToPhraseEnd(s.lastHardKick!, n), 144);
});

test('a kick at full strength from bar 1', () => {
  const b = set(full(100), 'kick', 97, 100, -30);
  const s = P.structurePoints(b);
  assert.deepEqual(s, { bars: 100, fullSectionStart: 1, firstHardKick: 1, lastHardKick: 96, firstFullPhrase: 1, introBars: 0, outroBars: 4 });
});

test('a dip shorter than 4 bars, or further back than 24 bars, does not move the hard kick', () => {
  // Intro 1-32 with thin mids, a 3-bar kick dip at 30-32: no dip.
  const b = set(set(full(80), 'mid', 1, 32, -9), 'kick', 30, 32, -8);
  assert.equal(P.structurePoints(b).firstHardKick, 33);
  // A 4-bar dip before the 24-bar look-back (bars 17-40): ignored.
  const c = set(set(full(100), 'mid', 1, 40, -9), 'kick', 12, 15, -8);
  assert.equal(P.structurePoints(c).firstHardKick, 41);
  // A 4-bar dip right before the run, inside the window: the kick returns after it.
  const d = set(set(full(100), 'mid', 1, 40, -9), 'kick', 20, 23, -8);
  assert.equal(P.structurePoints(d).firstHardKick, 24);
});

test('no run of 16 full bars: no points', () => {
  const b = set(full(40), 'kick', 16, 18, -10);
  // Three bars are never bridged: 1-15 (15 bars) and 19-40 (22 bars), the
  // second is the run; the first is still a phrase of full bars.
  assert.equal(P.structurePoints(b).fullSectionStart, 19);
  assert.equal(P.structurePoints(b).firstFullPhrase, 1);
  const none = set(full(30), 'mid', 1, 30, -9);
  assert.deepEqual(P.structurePoints(none), {
    bars: 30, fullSectionStart: null, firstHardKick: null, lastHardKick: null, firstFullPhrase: null, introBars: null, outroBars: null,
  });
  assert.equal(P.structurePoints({ kick: [], kicks: [], bass: [], mid: [] }).bars, 0);
});

test('arrays of unequal length are read to the shortest', () => {
  const b = full(20);
  b.mid = b.mid.slice(0, 17);
  assert.equal(P.structurePoints(b).bars, 17);
});

test('phrase snapping counts 8-bar phrases from bar 1', () => {
  // Starts are 1, 9, 17…; the nearest, the earlier one on a tie.
  assert.equal(P.snapToPhraseStart(1), 1);
  assert.equal(P.snapToPhraseStart(4), 1);
  assert.equal(P.snapToPhraseStart(5), 1, 'tie: the earlier phrase');
  assert.equal(P.snapToPhraseStart(6), 9);
  assert.equal(P.snapToPhraseStart(66), 65);
  // Ends are 8, 16, 24…
  assert.equal(P.snapToPhraseEnd(8), 8);
  assert.equal(P.snapToPhraseEnd(11), 8);
  assert.equal(P.snapToPhraseEnd(12), 8, 'tie: the earlier phrase');
  assert.equal(P.snapToPhraseEnd(13), 16);
  assert.equal(P.snapToPhraseEnd(3), 8, 'never before the first phrase end');
  // Kept within the track.
  assert.equal(P.snapToPhraseStart(99, 100), 97);
  assert.equal(P.snapToPhraseEnd(99, 100), 96);
  assert.equal(P.snapToPhraseEnd(103, 100), 96, 'a phrase end past the track: the last one inside it');
  assert.equal(P.snapToPhraseStart(103, 100), 97);
  assert.equal(P.snapToPhraseEnd(5, 6), 6, 'a track shorter than a phrase: its last bar');
});

test('bar starts map through the stored runs', () => {
  const runs: Array<[number, number, number]> = [[480, 1_935_484, 3], [7000, 2_000_000, 2]];
  assert.equal(P.barStartMs(runs, 1), 480);
  assert.equal(P.barStartMs(runs, 3), 480 + 2 * 1935.484);
  assert.equal(P.barStartMs(runs, 4), 7000);
  assert.equal(P.barStartMs(runs, 5), 9000);
  assert.equal(P.barStartMs(runs, 6), null);
  assert.equal(P.barStartMs(runs, 0), null);
});
