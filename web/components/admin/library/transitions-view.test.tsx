import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TransitionsView from './TransitionsView';
import {
  TIER_COPY, computedLine, partLabel, partTitle, pct, showRange, showTierCount,
} from './transition-readiness-view';
import {
  TRANSITION_PART_IDS, TRANSITION_TIER_IDS, transitionReadinessResponseSchema, type TransitionReadiness,
} from '../../../lib/schemas.generated';

const NOW = Date.parse('2026-11-24T12:00:00Z');

type Show = TransitionReadiness['shows'][number];
const house: Show = { id: 'h', name: 'House Night', maxStepPct: 3, curve: { lo: 118, hi: 126 }, phraseMix: true, tiers: { phrase: 300, beat: 90, safe: 0 }, outByStoredTempo: 80 };
const free: Show = { id: 'f', name: 'Free Flow', maxStepPct: 3, curve: null, phraseMix: false, tiers: { phrase: 500, beat: 200, safe: 0 }, outByStoredTempo: 300 };

const readiness: TransitionReadiness = {
  library: 1000,
  tiers: [
    { tier: 'phrase', tracks: 500, stems: 120, parts: [{ part: 'phrase-both', reason: null, tracks: 450 }, { part: 'phrase-out-only', reason: null, tracks: 50 }] },
    { tier: 'beat', tracks: 200, stems: 10, parts: [
      { part: 'bars-half-bar', reason: null, tracks: 150 },
      { part: 'structure-unmeasurable', reason: 'odd-meter', tracks: 40 },
      { part: 'structure-unmeasurable', reason: 'too-long', tracks: 10 },
    ] },
    { tier: 'safe', tracks: 0, stems: 0, parts: [] },
    { tier: 'out', tracks: 300, stems: 5, parts: [{ part: 'grid-held', reason: null, tracks: 200 }, { part: 'no-grid', reason: null, tracks: 100 }] },
  ],
  shows: [house, free],
  computedAt: new Date(NOW - 5 * 60_000).toISOString(),
  durationMs: 4012,
};

const render = (r: TransitionReadiness | null) => renderToStaticMarkup(createElement(TransitionsView, { readiness: r, now: NOW }));

test('every tier and every reason has plain words and a hover line', () => {
  for (const t of TRANSITION_TIER_IDS) {
    assert.ok(TIER_COPY[t].name && TIER_COPY[t].hears, t);
  }
  for (const p of TRANSITION_PART_IDS) {
    assert.ok(partLabel(p, null) !== p, `${p} has a label`);
    assert.ok(partTitle(p).length > 10, `${p} has a hover line`);
  }
  assert.equal(partLabel('structure-unmeasurable', 'odd-meter'), 'Structure unmeasurable: odd meter (not 4/4)');
  assert.equal(partLabel('structure-unmeasurable', 'something-new'), 'Structure unmeasurable: something-new');
});

test('shares, ranges and the out row per show', () => {
  assert.equal(pct(519, 1000), '51.9 %');
  assert.equal(pct(0, 1000), '0.0 %');
  assert.equal(pct(1, 100_000), '<0.1 %');
  assert.equal(pct(3, 0), '–');
  assert.equal(showRange(house), '114–130 BPM (curve 118–126 ±3 %)');
  assert.equal(showRange(free), 'no curve: any tempo, ±3 % a pick');
  assert.equal(showTierCount(house, 'phrase'), 300);
  assert.equal(showTierCount(house, 'out'), null);
  assert.match(computedLine(readiness, NOW), /^Counted 5 min ago over 1,000 tracks \(4\.0 s\)/);
});

test('the tab renders each tier with the library and every Hot Mix show', () => {
  assert.ok(transitionReadinessResponseSchema.safeParse({ readiness }).success);
  const html = render(readiness);
  for (const name of ['Phrase mix', 'Beat mix', 'Safe transition only', 'Not in Hot Mix']) assert.match(html, new RegExp(name));
  assert.match(html, /A seam needs both sides/);
  assert.match(html, /All tracks/);
  assert.match(html, /500 <span[^>]*>· 50\.0 %/);
  assert.match(html, /120 with stems saved/);
  assert.match(html, /House Night<\/span> · 114–130 BPM/);
  assert.match(html, /390 tracks it can pick, the base of its shares/);
  assert.match(html, /Bar line ambiguous \(beat 1 or 3\)/);
  assert.match(html, /≈ 80 in range by their untrusted tempo/);
  // The phrase row of a show with the phrase mix off says what airs instead.
  assert.match(html, /phrase mix off in this show: these air as beat mixes/);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 4 + 3 * 2, 'a bar per tier for the library, per trusted tier for each show');
});

test('no Hot Mix show: only the library column, and a note saying why', () => {
  const html = render({ ...readiness, shows: [] });
  assert.match(html, /No show has Hot Mix on/);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 4);
});

test('before the first count: a counting line, no figures', () => {
  const html = render(null);
  assert.match(html, /Counting the library/);
  assert.doesNotMatch(html, /All tracks/);
});
