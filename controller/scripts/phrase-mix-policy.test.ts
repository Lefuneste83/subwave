// The phrase mix's placement on its own: where the transition starts in the
// outgoing track, where the incoming one enters, how long it lasts, and every
// reason it stands down (the queue then searches the seam as before),
// including an entry that would skip a main section or more than a DJ intro,
// and a real extended mix whose two-bar drum fills once sent the entry 4 min in.
// Run: `npm test -- phrase-mix-policy`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENTRY_MAX_BARS, planPhraseWindow, type PhraseInput, type PhraseSide } from '../src/music/phrase-mix-policy.js';
import { structurePoints, type StructurePoints } from '../src/music/structure-policy.js';

// Four-beat bars at 120 BPM (2 s), bar 1 at 0.5 s: bar k starts at 0.5 + 2(k-1).
const at = (bar: number) => 0.5 + 2 * (bar - 1);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const RUNS = (bars: number): Array<[number, number, number]> => [[500, 2_000_000, bars]];

const points = (bars: number, first: number | null, last: number | null, full = first, phrase = full): StructurePoints => ({
  bars,
  fullSectionStart: full,
  firstHardKick: first,
  lastHardKick: last,
  firstFullPhrase: phrase,
  introBars: first == null ? null : first - 1,
  outroBars: last == null ? null : bars - last,
});

// A: 150 bars, the full section from bar 20, its last hard kick on bar 100.
const A = (over: Partial<PhraseSide & { endSec: number }> = {}) => ({
  points: points(150, 20, 100), runs: RUNS(150), cueInSec: 0, endSec: at(151), ...over,
});
// B like the operator's Aurora test track: a 64-bar intro, its first hard kick on bar 65.
const B = (over: Partial<PhraseSide> = {}) => ({ points: points(200, 65, 180), runs: RUNS(200), cueInSec: 0, ...over });
const input = (bars: number, over: Partial<PhraseInput> = {}): PhraseInput => ({ bars, a: A(), b: B(), ...over });

const ok = (v: ReturnType<typeof planPhraseWindow>) => {
  assert.ok(v.ok, JSON.stringify(v));
  return v.window;
};

test('eight bars: B enters 8 bars before its first hard kick, A leaves 8 bars after its last', () => {
  const w = ok(planPhraseWindow(input(8)));
  assert.deepEqual(w, {
    bars: 8,
    aStartBar: 101, aStartSec: at(101), aCutSec: at(109),
    bEntryBar: 57, bEntrySec: at(57),
    bPunchBar: 65, bPunchSec: at(65),
  });
  // The transition lasts exactly L bars on both sides.
  assert.equal(w.aCutSec - w.aStartSec, 8 * 2);
  assert.equal(w.bPunchSec - w.bEntrySec, 8 * 2);
});

test('sixteen bars: B enters 16 bars before its kick (bar 49)', () => {
  const w = ok(planPhraseWindow(input(16)));
  assert.equal(w.bars, 16);
  assert.equal(w.bEntryBar, 49);
  assert.equal(w.aStartBar, 101);
  assert.equal(w.aCutSec, at(117));
});

test('phrases count from the kick, never from bar 1', () => {
  // A first hard kick on bar 62 (not a grid 8-bar line): B enters on bar 54.
  const w = ok(planPhraseWindow(input(8, { b: B({ points: points(200, 62, 180) }) })));
  assert.equal(w.bEntryBar, 54);
  assert.equal(w.bPunchBar, 62);
  // A last hard kick on bar 97: A's overlap starts on bar 98.
  const v = ok(planPhraseWindow(input(8, { a: A({ points: points(150, 20, 97) }) })));
  assert.equal(v.aStartBar, 98);
});

test('a short intro shortens the transition to the whole phrases it holds', () => {
  // 12 bars before the kick: 16 asked, 8 fit.
  const w = ok(planPhraseWindow(input(16, { b: B({ points: points(200, 13, 180) }) })));
  assert.equal(w.bars, 8);
  assert.equal(w.bEntryBar, 5);
  assert.equal(w.aCutSec, at(109));
  // Exactly 8 bars before it: entry on bar 1.
  assert.equal(ok(planPhraseWindow(input(8, { b: B({ points: points(200, 9, 180) }) }))).bEntryBar, 1);
  // 32 asked, 31 bars of intro: 24.
  assert.equal(ok(planPhraseWindow(input(32, { b: B({ points: points(200, 32, 180) }) }))).bars, 24);
});

test('fewer than 8 bars before the kick: no phrase mix', () => {
  const v = planPhraseWindow(input(8, { b: B({ points: points(200, 6, 180) }) }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /fewer than 8 bars before its first hard kick/);
});

test('the incoming side never enters before its silence trim', () => {
  // 32 bars of intro; the trim at 3 s puts bar 1 out of reach: 24 bars.
  const w = ok(planPhraseWindow(input(32, { b: B({ points: points(200, 33, 180), cueInSec: 3 }) })));
  assert.equal(w.bars, 24);
  assert.equal(w.bEntryBar, 9);
  // Only 8 bars of intro, and the trim past bar 1: none fits.
  const v = planPhraseWindow(input(8, { b: B({ points: points(200, 9, 180), cueInSec: 5 }) }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /silence trim/);
});

test('a long outro: A leaves mid-outro, L bars after its last hard kick', () => {
  const w = ok(planPhraseWindow(input(8, { a: A({ points: points(200, 20, 136), runs: RUNS(200), endSec: at(201) }) })));
  assert.equal(w.aStartBar, 137);
  assert.equal(w.aCutSec, at(145));
  assert.ok(w.aCutSec < at(201) - 100, 'well before the track ends');
});

test('a short outro: the overlap moves back a phrase at a time, still anchored on the last kick', () => {
  // Three bars of outro: bars 148-150, the track ends at bar 151's line.
  const w = ok(planPhraseWindow(input(8, { a: A({ points: points(150, 20, 147) }) })));
  assert.equal(w.aStartBar, 140);
  assert.equal(w.aCutSec, at(148));
  // A trim ending A at 280 s: back two phrases.
  const t = ok(planPhraseWindow(input(8, { a: A({ points: points(150, 20, 147), endSec: 280 }) })));
  assert.equal(t.aStartBar, 132);
  assert.ok(t.aCutSec <= 280);
  // A cut on the track's very last bar line fits.
  const e = ok(planPhraseWindow(input(8, { a: A({ points: points(150, 20, 142) }) })));
  assert.equal(e.aStartBar, 143);
  assert.equal(e.aCutSec, at(151));
});

test('an outgoing track too short for the transition after its full section starts: no phrase mix', () => {
  const v = planPhraseWindow(input(8, { a: A({ points: points(150, 100, 105), endSec: 205 }) }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /the outgoing track ends before an 8-bar transition fits/);
  // Nor before its own cue-in.
  const c = planPhraseWindow(input(8, { a: A({ points: points(150, 2, 30, 2), endSec: 50, cueInSec: 40 }) }));
  assert.equal(c.ok, false);
});

test('no full section on either side: no phrase mix', () => {
  const a = planPhraseWindow(input(8, { a: A({ points: points(150, null, null) }) }));
  assert.equal(a.ok, false);
  assert.match((a as { reason: string }).reason, /no full section on the outgoing track/);
  const b = planPhraseWindow(input(8, { b: B({ points: points(200, null, null) }) }));
  assert.equal(b.ok, false);
  assert.match((b as { reason: string }).reason, /no full section on the incoming track/);
});

test('bar times come through every run of the stored bars', () => {
  // 40 bars of 2 s from 0.2 s, then bars of 1.95 s from 80.4 s.
  const runs: Array<[number, number, number]> = [[200, 2_000_000, 40], [80_400, 1_950_000, 160]];
  const w = ok(planPhraseWindow(input(8, { b: B({ runs }) })));
  assert.equal(w.bEntrySec, r4(80.4 + 16 * 1.95));
  assert.equal(w.bPunchSec, r4(80.4 + 24 * 1.95));
  // A cut on the line after the last stored bar is the end of that bar.
  const aRuns: Array<[number, number, number]> = [[500, 2_000_000, 100], [200_500, 1_900_000, 50]];
  const e = ok(planPhraseWindow(input(8, { a: A({ points: points(150, 20, 142), runs: aRuns, endSec: 300 }) })));
  assert.equal(e.aCutSec, r4(200.5 + 50 * 1.9));
});

test('an entry more than 56 bars past the trim is refused, a 64-bar intro\'s 56 is not', () => {
  assert.equal(ENTRY_MAX_BARS, 56);
  // A 72-bar intro: 8 bars before its kick is bar 65, 64 bars in.
  const deep = planPhraseWindow(input(8, { b: B({ points: points(200, 73, 180) }) }));
  assert.equal(deep.ok, false);
  assert.match((deep as { reason: string }).reason, /the entry at bar 65 is 129s into the incoming track \(over 56 bars\)/);
  // Sixteen bars before it is bar 57, 56 bars in: the 64-bar intro's own depth.
  assert.equal(ok(planPhraseWindow(input(16, { b: B({ points: points(200, 73, 180) }) }))).bEntryBar, 57);
  // A beatless lead-in before the grid's bar 1 counts from the trim: bar 57
  // of a grid starting 30 s in lies 142 s past a trim at 0, 113 s past one at 29.
  const late = (cueInSec: number) => planPhraseWindow(input(8, { b: B({ runs: [[30_000, 2_000_000, 200]], cueInSec }) }));
  assert.equal(late(0).ok, false);
  assert.equal(late(29).ok, true);
});

test('an entry a phrase or more into a run of full bars is refused: it would skip a main section', () => {
  // Full bars from bar 20 (a 14-bar groove the 16-bar rule does not count),
  // the first hard kick on 65: entering on bar 57 would skip the groove.
  const v = planPhraseWindow(input(8, { b: B({ points: points(200, 65, 180, 65, 20) }) }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /the entry at bar 57 would skip the incoming track's full bars from bar 20/);
  // A whole phrase of it skipped is refused; an entry up to 7 bars into it only
  // shortens it.
  assert.equal(planPhraseWindow(input(8, { b: B({ points: points(200, 65, 180, 65, 49) }) })).ok, false);
  assert.equal(ok(planPhraseWindow(input(8, { b: B({ points: points(200, 65, 180, 65, 50) }) }))).bEntryBar, 57);
});

// A real extended mix (122 BPM, 196 bars, 6:27) whose main sections carry
// two-bar drum fills (the kick 7-11 dB down on bars 47-48 and 88-89). Under a
// one-bar fill rule its runs broke into 14, 7, 14 and 15 bars, the first hard
// kick landed on bar 142 after the third breakdown, and a 16-bar window
// entered on bar 126, 4 min in: it aired for 2:20.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TWO_BAR_FILLS = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'structure-two-bar-fills.json'), 'utf8'));

test('an extended mix with two-bar fills enters on bar 17, before its first main section', () => {
  const p = structurePoints(TWO_BAR_FILLS);
  assert.equal(p.bars, 196);
  assert.equal(p.firstHardKick, 33);
  assert.equal(p.fullSectionStart, 33);
  assert.equal(p.firstFullPhrase, 33);
  assert.equal(p.lastHardKick, 187);
  const w = ok(planPhraseWindow(input(16, { b: { points: p, runs: TWO_BAR_FILLS.runs, cueInSec: 0 } })));
  assert.equal(w.bars, 16);
  assert.equal(w.bEntryBar, 17);
  assert.equal(w.bEntrySec, r4((20 + 16 * 1967.248) / 1000)); // 31.5 s
  assert.equal(w.bPunchBar, 33);
});

test('the entry guard alone refuses the 4-minute entry those fills once produced', () => {
  // The points the one-bar fill rule read: first hard kick 142, and a
  // 14-bar groove from bar 33.
  const v = planPhraseWindow(input(16, { b: { points: points(196, 142, 187, 142, 33), runs: TWO_BAR_FILLS.runs, cueInSec: 0 } }));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /the entry at bar 126 would skip the incoming track's full bars from bar 33/);
});
