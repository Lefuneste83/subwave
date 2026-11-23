// DJ Hot Mix, the rules on their own: the tempo resolver, the octave-safe
// step, the curve and the window it anchors, the window's two failure
// directions, the requests toggle, and the saved shape on both the strict save
// path and the lenient load path.
// Run: `npm test -- hot-mix-policy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curveBpmAt, describeTempoWindow, fitsTempoWindow, hotMixOf, hotMixRankTarget, mixTempoOf, nearestTempoFallback, octaveNearest,
  takesRequests, targetBpmAt, tempoStepPct, tempoWindowFor, withinCurveReach, withinTempoWindow,
} from '../src/music/hot-mix-policy.js';
import { HOT_MIX_PHRASE_BARS, HOT_MIX_PHRASE_BARS_DEFAULT, HOT_MIX_STEP_PCT_DEFAULT, repairHotMix, repairShowForLoad, showSchema } from '../src/schemas/show.js';
import { prevShowChangeMs } from '../src/broadcast/show-boundary.js';

const show = (hotMix: unknown) => ({ hotMix });
const ON = (extra: Record<string, unknown> = {}) => show({ enabled: true, ...extra });

// ─── the tempo a mix can trust ──────────────────────────────────────────────

// A grid of `bpm` over a 300 s track, steady for `steady` of it (one segment at
// that tempo), the rest a segment 10 % slower.
function grid(bpm: number, { steady = 0.95, applied = 0 as -1 | 0 | 1, status = 'ok' as 'ok' | 'unmeasurable' | 'failed' } = {}) {
  const decodedMs = 300_000;
  const periodUs = 60_000_000 / bpm;
  const beats = Math.round((steady * decodedMs * 1000) / periodUs) + 1;
  const slowUs = periodUs * 1.1;
  const restBeats = Math.max(2, Math.round(((1 - steady) * decodedMs * 1000) / slowUs));
  return {
    status, bpm, applied, decodedMs,
    segments: [
      { anchorMs: 0, periodUs, beats, downbeatMs: 0 },
      { anchorMs: (beats * periodUs) / 1000, periodUs: slowUs, beats: restBeats, downbeatMs: null },
    ],
  };
}

test('resolver: an applied grid answers with the stored tempo, which is the grid\'s', () => {
  assert.equal(mixTempoOf({ bpm: 124.2, grid: grid(124.2, { applied: 1 }) }), 124.2);
  // Applied but the stored tempo is gone: nothing to trust.
  assert.equal(mixTempoOf({ bpm: null, grid: grid(124.2, { applied: 1 }) }), null);
});

test('resolver: a steady grid held only by its coverage answers with the grid\'s tempo', () => {
  // The head estimate read 99.4 over the first 40 s; the whole-track grid
  // holds 125 on most of the track but was not written (coverage under 0.8).
  assert.equal(mixTempoOf({ bpm: 99.38, grid: grid(125, { steady: 0.917 }) }), 125);
  // An operator-reverted grid is not written either; its steady tempo still judges a mix.
  assert.equal(mixTempoOf({ bpm: 99.38, grid: grid(125, { applied: -1 }) }), 125);
});

test('resolver: an unsteady grid, no grid, a failed one or double time is unknown', () => {
  assert.equal(mixTempoOf({ bpm: 99.38, grid: grid(125, { steady: 0.4 }) }), null);
  assert.equal(mixTempoOf({ bpm: 123.05, grid: null }), null);
  assert.equal(mixTempoOf({ bpm: 123.05, grid: { ...grid(125), status: 'unmeasurable' } }), null);
  assert.equal(mixTempoOf({ bpm: 123.05, grid: { ...grid(125), status: 'failed' } }), null);
  assert.equal(mixTempoOf({ bpm: 110, grid: grid(220) }), null);
  assert.equal(mixTempoOf(null), null);
  // The steady share is grid-policy's: every segment within its band counts.
  const split = grid(125, { steady: 0.35 });
  split.segments.push({ anchorMs: 200_000, periodUs: 60_000_000 / 126, beats: 200, downbeatMs: null });
  assert.equal(mixTempoOf({ bpm: 99.38, grid: split }), 125);
});

test('resolver: a resolved tempo is judged octave-safe like any other', () => {
  const w = tempoWindowFor(ON({ curve: [{ at: 0, bpm: 124 }] }), null, 0)!;
  assert.equal(fitsTempoWindow(mixTempoOf({ bpm: 99.38, grid: grid(62.5) }), w), true);
  assert.equal(fitsTempoWindow(mixTempoOf({ bpm: 99.38, grid: grid(125) }), w), true);
});

// ─── the step ───────────────────────────────────────────────────────────────

test('the step is octave-safe: half and double time sit next to the anchor', () => {
  assert.equal(octaveNearest(128, 64), 128);
  assert.equal(octaveNearest(128, 256), 128);
  assert.equal(tempoStepPct(128, 64), 0);
  assert.ok(Math.abs((tempoStepPct(120, 126) as number) - 5) < 1e-9);
  // 70 against 128: doubled to 140, 9.4 % away, never read as 45 % slower.
  assert.ok(Math.abs((tempoStepPct(128, 70) as number) - 9.375) < 1e-9);
});

test('an unusable tempo has no step at all', () => {
  assert.equal(tempoStepPct(128, null), null);
  assert.equal(tempoStepPct(null, 128), null);
  assert.equal(tempoStepPct(128, 0), null);
  assert.equal(tempoStepPct(128, Number.NaN), null);
});

// ─── the curve ──────────────────────────────────────────────────────────────

test('the curve is linear between points and flat beyond its ends', () => {
  const curve = [{ at: 0, bpm: 118 }, { at: 50, bpm: 128 }, { at: 100, bpm: 122 }];
  assert.equal(curveBpmAt(curve, 0), 118);
  assert.equal(curveBpmAt(curve, 0.25), 123);
  assert.equal(curveBpmAt(curve, 0.5), 128);
  assert.equal(curveBpmAt(curve, 0.75), 125);
  assert.equal(curveBpmAt([{ at: 20, bpm: 120 }], 0.05), 120);
  assert.equal(curveBpmAt(curve, null), null);
  assert.equal(curveBpmAt([], 0.5), null);
});

// ─── the window ─────────────────────────────────────────────────────────────

test('off, malformed or absent is no window: the show picks as it always did', () => {
  assert.equal(tempoWindowFor(show(undefined), 128, null), null);
  assert.equal(tempoWindowFor(show({ enabled: false }), 128, null), null);
  assert.equal(tempoWindowFor(show('yes'), 128, null), null);
  assert.equal(tempoWindowFor(null, 128, null), null);
  assert.equal(hotMixOf(show({ enabled: 'true' })), null);
});

test('the window is the step around the anchor, the default when the step is bad', () => {
  const w = tempoWindowFor(ON(), 125, null)!;
  assert.equal(HOT_MIX_STEP_PCT_DEFAULT, 3);
  assert.deepEqual(w, { anchorBpm: 125, maxStepPct: HOT_MIX_STEP_PCT_DEFAULT, targetBpm: null, anchoredOn: 'predecessor' });
  assert.equal(tempoWindowFor(ON({ maxStepPct: 400 }), 125, null)!.maxStepPct, HOT_MIX_STEP_PCT_DEFAULT);
  assert.equal(tempoWindowFor(ON({ maxStepPct: 3 }), 125, null)!.maxStepPct, 3);
  assert.equal(fitsTempoWindow(128.75, w), true);
  assert.equal(fitsTempoWindow(129, w), false);
  assert.equal(fitsTempoWindow(64, w), true);
  assert.equal(fitsTempoWindow(null, w), false);
});

test('without a curve, an anchor with no tempo has no window', () => {
  assert.equal(tempoWindowFor(ON(), null, 0.5), null);
  assert.equal(tempoWindowFor(ON(), 0, 0.5), null);
});

test('with a curve the window is the step around the curve\'s tempo, never the predecessor\'s', () => {
  // The predecessor closed the previous show at 96; the curve asks for 122.
  const curve = [{ at: 0, bpm: 122 }, { at: 50, bpm: 124 }, { at: 75, bpm: 123 }, { at: 90, bpm: 122 }];
  const w = tempoWindowFor(ON({ curve, maxStepPct: 3 }), 96, 0)!;
  assert.deepEqual(w, { anchorBpm: 122, maxStepPct: 3, targetBpm: 122, anchoredOn: 'curve' });
  assert.equal(fitsTempoWindow(125, w), true);
  assert.equal(fitsTempoWindow(99.38, w), false);
  assert.equal(fitsTempoWindow(98.9, w), false, 'within a step of the predecessor is no longer enough');
  // The same window whatever the predecessor, unknown included.
  assert.deepEqual(tempoWindowFor(ON({ curve, maxStepPct: 3 }), null, 0), w);
  assert.deepEqual(tempoWindowFor(ON({ curve, maxStepPct: 3 }), 140, 0), w);
  // Interpolated at the pick's own position.
  assert.equal(tempoWindowFor(ON({ curve, maxStepPct: 3 }), 96, 0.25)!.anchorBpm, 123);
  assert.equal(targetBpmAt(ON({ curve }), 0.25), 123);
  assert.equal(targetBpmAt(ON(), 0.25), null);
  assert.equal(targetBpmAt(show({ enabled: false, curve }), 0.25), null);
  // A curve at an unknown position stands aside: the predecessor anchors.
  assert.deepEqual(tempoWindowFor(ON({ curve, maxStepPct: 3 }), 120, null), { anchorBpm: 120, maxStepPct: 3, targetBpm: null, anchoredOn: 'predecessor' });
  assert.match(describeTempoWindow(w), /^118-126 BPM around 122 \(±3%, the curve's tempo\)$/);
  assert.match(describeTempoWindow(tempoWindowFor(ON(), 124, null)!), /around 124 \(±3%, the previous track's tempo\)/);
});

test('inside a curve\'s window the tempos on its target come first, each group in the order it came', () => {
  const w = tempoWindowFor(ON({ curve: [{ at: 0, bpm: 122 }], maxStepPct: 3 }), 96, 0)!;
  const tracks = [{ id: 'edge-low', bpm: 118.5 }, { id: 'far', bpm: 130 }, { id: 'on', bpm: 122.5 }, { id: 'edge-high', bpm: 125 }, { id: 'half', bpm: 61 }, { id: 'none', bpm: null }];
  assert.deepEqual(withinTempoWindow(tracks, w, (t) => t.bpm).map((t) => t.id), ['on', 'half', 'edge-low', 'edge-high']);
  // Without a curve the window keeps the order it was given.
  const free = tempoWindowFor(ON({ maxStepPct: 3 }), 122, null)!;
  assert.deepEqual(withinTempoWindow(tracks, free, (t) => t.bpm).map((t) => t.id), ['edge-low', 'on', 'edge-high', 'half']);
});

test('the ranking aims at the window\'s anchor tempo with the predecessor\'s key', () => {
  const w = tempoWindowFor(ON({ curve: [{ at: 0, bpm: 122 }] }), 96, 0)!;
  assert.deepEqual(hotMixRankTarget(w, { bpm: 96, key: '8A', keyEnd: '9A' }), { bpm: 122, key: '8A', keyEnd: '9A' });
  assert.deepEqual(hotMixRankTarget(w, null), { key: null, bpm: 122 });
  const pred = { bpm: 96, key: '8A' };
  assert.equal(hotMixRankTarget(null, pred), pred);
});

test('the curve\'s reach: the step around its lowest to highest tempo, octave-safe', () => {
  const hm = hotMixOf(ON({ curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 126 }], maxStepPct: 3 }))!;
  assert.equal(withinCurveReach(116.5, hm), true);
  assert.equal(withinCurveReach(129.7, hm), true);
  assert.equal(withinCurveReach(64, hm), true);
  assert.equal(withinCurveReach(99.38, hm), false);
  assert.equal(withinCurveReach(null, hm), false);
  assert.equal(withinCurveReach(122, hotMixOf(ON())!), false);
});

test('the hard window drops unknown tempos and hands back a fresh array', () => {
  const w = tempoWindowFor(ON(), 128, null)!;
  const input = [{ bpm: 128 }];
  const out = withinTempoWindow(input, w, (t) => t.bpm);
  assert.notEqual(out, input);
  assert.deepEqual(withinTempoWindow([{ bpm: null }, { bpm: 200 }], w, (t) => t.bpm), []);
});

// ─── never-starve ───────────────────────────────────────────────────────────

test('the fallback measures from the curve\'s target, not the predecessor', () => {
  const w = tempoWindowFor(ON({ curve: [{ at: 0, bpm: 122 }], maxStepPct: 3 }), 96, 0)!;
  const fit = nearestTempoFallback([
    { id: 'near-predecessor', bpm: 97, key: null },
    { id: 'nearest-target', bpm: 128, key: null },
    { id: 'unknown', bpm: null, key: null },
  ], w, (t) => t, null);
  assert.equal(fit.relaxed, true);
  assert.deepEqual(fit.tracks.map((t) => t.id), ['nearest-target']);
});

test('the fallback keeps the window when it has anything', () => {
  const w = tempoWindowFor(ON(), 128, null)!;
  const fit = nearestTempoFallback([{ id: 'in', bpm: 130, key: null }, { id: 'out', bpm: 150, key: null }], w, (t) => t, null);
  assert.equal(fit.relaxed, false);
  assert.deepEqual(fit.tracks.map((t) => t.id), ['in']);
});

test('with nothing in the window: nearest tempo first, a compatible key breaks near-ties', () => {
  const w = tempoWindowFor(ON({ maxStepPct: 2 }), 128, null)!;
  const tracks = [
    { id: 'far', bpm: 150, key: '8A' },
    { id: 'near-clash', bpm: 134, key: '3B' },
    { id: 'near-match', bpm: 134.5, key: '9A' },
    { id: 'unknown', bpm: null, key: '8A' },
  ];
  const fit = nearestTempoFallback(tracks, w, (t) => t, '8A');
  assert.equal(fit.relaxed, true);
  // 150 is 17 % away, beyond one step past the nearest (4.7 % + 2 %): left out.
  assert.deepEqual(fit.tracks.map((t) => t.id), ['near-match', 'near-clash']);
});

test('the fallback never returns its input, and only offers unknown tempos when nothing else exists', () => {
  const w = tempoWindowFor(ON(), 128, null)!;
  const input = [{ bpm: null, key: null }];
  const fit = nearestTempoFallback(input, w, (t) => t, null);
  assert.notEqual(fit.tracks, input);
  assert.deepEqual(fit.tracks, input);
});

// ─── requests ───────────────────────────────────────────────────────────────

test('a Hot Mix show closes requests by default; the toggle opens them', () => {
  assert.equal(takesRequests(null), true);
  assert.equal(takesRequests(show(undefined)), true);
  assert.equal(takesRequests(show({ enabled: false, closeRequests: true })), true);
  assert.equal(takesRequests(ON()), false);
  assert.equal(takesRequests(ON({ closeRequests: true })), false);
  assert.equal(takesRequests(ON({ closeRequests: false })), true);
});

// ─── the saved shape ────────────────────────────────────────────────────────

const ctx = { personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null };
const parse = (extra: Record<string, unknown>) => showSchema(ctx).safeParse({ name: 'Mix', personaId: 'p', ...extra });

test('a show saved before the field reads as off, with the defaults', () => {
  const r = parse({});
  assert.ok(r.success);
  assert.deepEqual(r.data.hotMix, { enabled: false, maxStepPct: 3, curve: [], closeRequests: true, phraseBars: 8, phraseMix: false });
  assert.deepEqual(parse({ hotMix: null }).data?.hotMix, { enabled: false, maxStepPct: 3, curve: [], closeRequests: true, phraseBars: 8, phraseMix: false });
});

test('save: numeric strings are read, the curve is ordered and de-duplicated by position', () => {
  const r = parse({ hotMix: { enabled: true, maxStepPct: '4', curve: [{ at: '100', bpm: 124 }, { at: 0, bpm: '118' }, { at: 100, bpm: 126 }], closeRequests: false } });
  assert.ok(r.success);
  assert.deepEqual(r.data.hotMix, { enabled: true, maxStepPct: 4, curve: [{ at: 0, bpm: 118 }, { at: 100, bpm: 126 }], closeRequests: false, phraseBars: 8, phraseMix: false });
});

test('save REFUSES an out-of-bounds step or curve point; load drops or defaults it', () => {
  assert.equal(parse({ hotMix: { enabled: true, maxStepPct: 50 } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: [{ at: 120, bpm: 128 }] } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: [{ at: 50, bpm: 400 }] } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: Array.from({ length: 9 }, (_, i) => ({ at: i * 10, bpm: 120 })) } }).success, false);
  assert.deepEqual(repairHotMix({ enabled: true, maxStepPct: 50, curve: [{ at: 120, bpm: 128 }, { at: 50, bpm: 126 }, 'x'] }),
    { enabled: true, maxStepPct: 3, curve: [{ at: 50, bpm: 126 }], closeRequests: true, phraseBars: 8, phraseMix: false });
  assert.deepEqual(repairHotMix('on'), { enabled: false, maxStepPct: 3, curve: [], closeRequests: true, phraseBars: 8, phraseMix: false });
});

test('the phrase length: 8, 16, 24 or 32 bars, 8 by default; the phrase mix is opt-in', () => {
  assert.equal(HOT_MIX_PHRASE_BARS_DEFAULT, 8);
  assert.deepEqual([...HOT_MIX_PHRASE_BARS], [8, 16, 24, 32]);
  const r = parse({ hotMix: { enabled: true, phraseBars: '16', phraseMix: true } });
  assert.ok(r.success);
  assert.equal(r.data.hotMix.phraseBars, 16);
  assert.equal(r.data.hotMix.phraseMix, true);
  // Absent: today's eight bars, placement searched as before.
  const plain = parse({ hotMix: { enabled: true } });
  assert.ok(plain.success);
  assert.equal(plain.data.hotMix.phraseBars, 8);
  assert.equal(plain.data.hotMix.phraseMix, false);
  assert.equal(parse({ hotMix: { enabled: true, phraseMix: 'true' } }).data?.hotMix.phraseMix, false, 'only a real true opts in');
  assert.equal(parse({ hotMix: { enabled: true, phraseBars: null } }).data?.hotMix.phraseBars, 8);
});

test('save REFUSES a phrase length off the list; load repairs it to 8', () => {
  for (const bad of [12, 0, 40, -8, 'x', 16.5]) {
    assert.equal(parse({ hotMix: { enabled: true, phraseBars: bad } }).success, false, `refuses ${bad}`);
  }
  assert.equal(repairHotMix({ enabled: true, phraseBars: 12 }).phraseBars, 8);
  assert.equal(repairHotMix({ enabled: true, phraseBars: '24' }).phraseBars, 24);
  assert.equal(repairHotMix({ enabled: true, phraseBars: 'x' }).phraseBars, 8);
  assert.equal(repairHotMix({ enabled: true, phraseMix: 1 }).phraseMix, false);
  assert.equal(repairHotMix({ enabled: true, phraseMix: true }).phraseMix, true);
  const repaired = repairShowForLoad({ name: 'Mix', personaId: 'p', hotMix: { enabled: true, phraseBars: 12, phraseMix: true } }, null);
  const r = showSchema(ctx).safeParse(repaired);
  assert.ok(r.success);
  assert.equal(r.data.hotMix.phraseBars, 8);
  assert.equal(r.data.hotMix.phraseMix, true);
});

test('the phrase settings round-trip through save and the switch reader', () => {
  const r = parse({ hotMix: { enabled: true, phraseBars: 32, phraseMix: true } });
  assert.ok(r.success);
  const again = parse({ hotMix: r.data.hotMix });
  assert.ok(again.success);
  assert.deepEqual(again.data.hotMix, r.data.hotMix);
  assert.deepEqual(repairHotMix(r.data.hotMix), r.data.hotMix);
  const hm = hotMixOf({ hotMix: r.data.hotMix });
  assert.equal(hm?.phraseBars, 32);
  assert.equal(hm?.phraseMix, true);
  assert.equal(hotMixOf(ON())?.phraseBars, 8);
  assert.equal(hotMixOf(ON())?.phraseMix, false);
});

test('the load path repairs before the schema, so a stale block costs the value, not the show', () => {
  const repaired = repairShowForLoad({ name: 'Mix', personaId: 'p', hotMix: { enabled: true, maxStepPct: 99, curve: [{ at: 'x', bpm: 1 }] } }, null);
  const r = showSchema(ctx).safeParse(repaired);
  assert.ok(r.success);
  assert.deepEqual(r.data.hotMix, { enabled: true, maxStepPct: 3, curve: [], closeRequests: true, phraseBars: 8, phraseMix: false });
  assert.equal(repairShowForLoad({ name: 'Mix', personaId: 'p' }, null).hotMix, undefined);
});

// ─── the show's start ───────────────────────────────────────────────────────

test('prevShowChangeMs: the hour the show on air began, or null past the horizon', () => {
  const H = 3_600_000;
  const t0 = 1_000 * H;
  // Shows change at t0 and t0 + 3h; the one on air at t0 + 2.5h began at t0.
  const keyAt = (ms: number) => (ms < t0 ? 'a' : ms < t0 + 3 * H ? 'b' : 'c');
  const minuteAt = (ms: number) => Math.floor(ms / 60_000) % 60;
  assert.equal(prevShowChangeMs({ atMs: t0 + 2.5 * H, horizonMs: 12 * H, keyAt, minuteAt }), t0);
  assert.equal(prevShowChangeMs({ atMs: t0 + 2.5 * H, horizonMs: 2 * H, keyAt, minuteAt }), null);
  // A takeover edge between hours is a change like any other.
  assert.equal(prevShowChangeMs({ atMs: t0 + 2.5 * H, horizonMs: 12 * H, keyAt: (ms) => (ms < t0 + 2.2 * H ? 'b' : 'x'), minuteAt, extra: [t0 + 2.2 * H] }), t0 + 2.2 * H);
});
