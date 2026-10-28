// What a regular run (GUI tagger / Analyze audio) plans when the whole-file
// lane is on: music/regular-run-plan.ts. The end-to-end order (lane 1 first,
// placed tails, convergence) is pinned in tail-placement.test.ts.
//
// Run: npm test -- regular-run-plan

import assert from 'node:assert/strict';
import test from 'node:test';
import { FACET_VERSIONS, type Facet, type FacetCell } from '../src/music/library-db/facets.js';
import { leadIds, regularRunFacets, regularRunPlan } from '../src/music/regular-run-plan.js';

const ok = (f: Facet, version = FACET_VERSIONS[f]): [Facet, FacetCell] => [f, { status: 'ok', version, attempts: 0, reason: null }];
const unm = (f: Facet, reason: string, version = FACET_VERSIONS[f]): [Facet, FacetCell] =>
  [f, { status: 'unmeasurable', version, attempts: 0, reason }];
const caps = { clap: true, demucs: true, tailVocal: true, wholeFile: true };
const none = { clap: false, vocal: false, stems: false };

// A fully analysed track with placed tail and whole-file facets.
const done = (): Map<Facet, FacetCell> => new Map([ok('head'), ok('loudness'), ok('edges'), ok('tail')]);

test('the model lane: head before tail, the opt-ins after, never the whole-file facets', () => {
  assert.deepEqual(regularRunFacets(none), ['head', 'tail']);
  assert.deepEqual(regularRunFacets({ clap: true, vocal: true, stems: true }), ['head', 'tail', 'clap', 'vocal', 'stems']);
});

test('a new track gets its head and tail in one item; a converged track nothing', () => {
  const state = new Map([['new', new Map()], ['done', done()]]);
  const plan = regularRunPlan({ ids: ['new', 'done'], state, wants: none, capabilities: caps });
  assert.deepEqual(plan.items.map(i => [i.id, i.facets]), [['new', ['head', 'tail']]]);
});

test('an outdated tail is planned again once the edges can place it, never before', () => {
  const placeable = done();
  placeable.set('tail', { status: 'unmeasurable', version: FACET_VERSIONS.tail - 1, attempts: 0, reason: 'capped-download' });
  const v1 = done();
  v1.set('tail', { status: 'ok', version: 1, attempts: 0, reason: null });
  const noEdges = new Map([ok('head'), ok('loudness'), unm('tail', 'capped-download', FACET_VERSIONS.tail - 1)]);
  const state = new Map([['placeable', placeable], ['v1', v1], ['no-edges', noEdges]]);
  const plan = regularRunPlan({ ids: ['placeable', 'v1', 'no-edges'], state, wants: none, capabilities: caps });
  assert.deepEqual(plan.items.map(i => [i.id, i.facets]), [['placeable', ['tail']], ['v1', ['tail']]]);
  const tail = plan.byFacet.find(c => c.facet === 'tail')!;
  assert.deepEqual([tail.matched, tail.planned, tail.skipped['no-edges']], [3, 2, 1],
    'a re-read without edges would give the same window, due again on every run');
  // ...and lane 1 is asked for that track's edges first.
  assert.deepEqual(leadIds(['placeable', 'v1', 'no-edges'], state), ['placeable', 'v1', 'no-edges']);
});

test('lead ids: only the tracks the model lane reads with head or tail due', () => {
  const clapOnly = done(); // head and tail done, CLAP missing
  const state = new Map([['new', new Map()], ['clap-only', clapOnly], ['done', done()]]);
  assert.deepEqual(leadIds(['new', 'clap-only', 'done'], state), ['new']);
});

test('stems-only work goes last, in stem-priority order, within the budget', () => {
  const withStems = (f = done()) => { f.set('clap', ok('clap')[1]); f.set('vocal', ok('vocal')[1]); return f; };
  const state = new Map<string, Map<Facet, FacetCell>>([
    ['new', new Map()], ['s1', withStems()], ['s2', withStems()], ['s3', withStems()],
  ]);
  const wants = { clap: true, vocal: true, stems: true };
  const base = { ids: ['s1', 's2', 's3', 'new'], state, wants, capabilities: caps };
  // Priority s3, s1, s2; headroom 3 slots, of which the new track's stems take 1.
  const plan = regularRunPlan({ ...base, stems: { priority: ['s3', 's1', 's2'], headroom: 3, existing: new Set() } });
  assert.deepEqual(plan.items.map(i => i.id), ['new', 's3', 's1']);
  const stems = plan.byFacet.find(c => c.facet === 'stems')!;
  assert.deepEqual([stems.matched, stems.planned, stems.skipped.limit], [4, 3, 1]);
  // A track not in the priority scan (excluded there) gets no stems-only item.
  const off = regularRunPlan({ ...base, stems: { priority: ['s2'], headroom: 10, existing: new Set() } });
  assert.deepEqual(off.items.map(i => i.id), ['new', 's2']);
  // An existing stem dir costs the new item no slot.
  const rewrite = regularRunPlan({ ...base, stems: { priority: ['s3', 's1', 's2'], headroom: 1, existing: new Set(['new']) } });
  assert.deepEqual(rewrite.items.map(i => i.id), ['new', 's3']);
});

test('the run\'s limit caps the plan after the stem ordering', () => {
  const state = new Map([['a', new Map()], ['b', new Map()], ['c', new Map()]]);
  const plan = regularRunPlan({ ids: ['a', 'b', 'c'], state, wants: none, capabilities: caps, limit: 2 });
  assert.deepEqual(plan.items.map(i => i.id), ['a', 'b']);
  assert.equal(plan.byFacet.find(c => c.facet === 'head')!.skipped.limit, 1);
});
