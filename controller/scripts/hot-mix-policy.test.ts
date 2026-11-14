// DJ Hot Mix, the rules on their own: the octave-safe step, the curve, the
// window and its two failure directions, the requests toggle, and the saved
// shape on both the strict save path and the lenient load path.
// Run: `npm test -- hot-mix-policy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curveBpmAt, fitsTempoWindow, hotMixOf, nearestTempoFallback, octaveNearest, takesRequests,
  tempoStepPct, tempoWindowFor, withinTempoWindow,
} from '../src/music/hot-mix-policy.js';
import { HOT_MIX_STEP_PCT_DEFAULT, repairHotMix, repairShowForLoad, showSchema } from '../src/schemas/show.js';
import { prevShowChangeMs } from '../src/broadcast/show-boundary.js';

const show = (hotMix: unknown) => ({ hotMix });
const ON = (extra: Record<string, unknown> = {}) => show({ enabled: true, ...extra });

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
  assert.deepEqual(w, { anchorBpm: 125, maxStepPct: HOT_MIX_STEP_PCT_DEFAULT, targetBpm: null, toward: null });
  assert.equal(tempoWindowFor(ON({ maxStepPct: 400 }), 125, null)!.maxStepPct, HOT_MIX_STEP_PCT_DEFAULT);
  assert.equal(tempoWindowFor(ON({ maxStepPct: 3 }), 125, null)!.maxStepPct, 3);
  assert.equal(fitsTempoWindow(132.5, w), true);
  assert.equal(fitsTempoWindow(133, w), false);
  assert.equal(fitsTempoWindow(64, w), true);
  assert.equal(fitsTempoWindow(null, w), false);
});

test('an anchor with no tempo falls back to the curve, and with no curve there is no window', () => {
  assert.equal(tempoWindowFor(ON(), null, 0.5), null);
  const w = tempoWindowFor(ON({ curve: [{ at: 0, bpm: 120 }, { at: 100, bpm: 130 }] }), null, 0.5)!;
  assert.equal(w.anchorBpm, 125);
  assert.equal(w.toward, null);
});

test('the curve says which way to move; it never widens the step', () => {
  const curve = [{ at: 0, bpm: 120 }, { at: 100, bpm: 140 }];
  const up = tempoWindowFor(ON({ curve }), 120, 1)!;
  assert.equal(up.toward, 'up');
  assert.equal(up.maxStepPct, 6);
  const tracks = [{ id: 'down', bpm: 116 }, { id: 'far', bpm: 140 }, { id: 'up', bpm: 125 }, { id: 'none', bpm: null }];
  const offered = withinTempoWindow(tracks, up, (t) => t.bpm).map((t) => t.id);
  assert.deepEqual(offered, ['up', 'down']);
  // On the curve: both sides equally welcome, in the order they came.
  const level = tempoWindowFor(ON({ curve }), 130, 0.5)!;
  assert.equal(level.toward, null);
  assert.deepEqual(withinTempoWindow([{ bpm: 126 }, { bpm: 134 }], level, (t) => t.bpm).map((t) => t.bpm), [126, 134]);
});

test('the hard window drops unknown tempos and hands back a fresh array', () => {
  const w = tempoWindowFor(ON(), 128, null)!;
  const input = [{ bpm: 128 }];
  const out = withinTempoWindow(input, w, (t) => t.bpm);
  assert.notEqual(out, input);
  assert.deepEqual(withinTempoWindow([{ bpm: null }, { bpm: 200 }], w, (t) => t.bpm), []);
});

// ─── never-starve ───────────────────────────────────────────────────────────

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
  assert.deepEqual(fit.tracks.map((t) => t.id), ['near-match', 'near-clash', 'far']);
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
  assert.deepEqual(r.data.hotMix, { enabled: false, maxStepPct: 6, curve: [], closeRequests: true });
  assert.deepEqual(parse({ hotMix: null }).data?.hotMix, { enabled: false, maxStepPct: 6, curve: [], closeRequests: true });
});

test('save: numeric strings are read, the curve is ordered and de-duplicated by position', () => {
  const r = parse({ hotMix: { enabled: true, maxStepPct: '4', curve: [{ at: '100', bpm: 124 }, { at: 0, bpm: '118' }, { at: 100, bpm: 126 }], closeRequests: false } });
  assert.ok(r.success);
  assert.deepEqual(r.data.hotMix, { enabled: true, maxStepPct: 4, curve: [{ at: 0, bpm: 118 }, { at: 100, bpm: 126 }], closeRequests: false });
});

test('save REFUSES an out-of-bounds step or curve point; load drops or defaults it', () => {
  assert.equal(parse({ hotMix: { enabled: true, maxStepPct: 50 } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: [{ at: 120, bpm: 128 }] } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: [{ at: 50, bpm: 400 }] } }).success, false);
  assert.equal(parse({ hotMix: { enabled: true, curve: Array.from({ length: 9 }, (_, i) => ({ at: i * 10, bpm: 120 })) } }).success, false);
  assert.deepEqual(repairHotMix({ enabled: true, maxStepPct: 50, curve: [{ at: 120, bpm: 128 }, { at: 50, bpm: 126 }, 'x'] }),
    { enabled: true, maxStepPct: 6, curve: [{ at: 50, bpm: 126 }], closeRequests: true });
  assert.deepEqual(repairHotMix('on'), { enabled: false, maxStepPct: 6, curve: [], closeRequests: true });
});

test('the load path repairs before the schema, so a stale block costs the value, not the show', () => {
  const repaired = repairShowForLoad({ name: 'Mix', personaId: 'p', hotMix: { enabled: true, maxStepPct: 99, curve: [{ at: 'x', bpm: 1 }] } }, null);
  const r = showSchema(ctx).safeParse(repaired);
  assert.ok(r.success);
  assert.deepEqual(r.data.hotMix, { enabled: true, maxStepPct: 6, curve: [], closeRequests: true });
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
