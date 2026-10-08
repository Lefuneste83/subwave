// The Musical Leanings review is ONE pass shared by both selection routes
// (broadcast/dj-agent/leanings-pass.ts). These drive it with a fake model call,
// the same injection runArtistGuard uses, so the outcomes are pinned on
// behaviour rather than on the shape of dj-agent.ts's source.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-leanings-pass-'));

const { runLeaningsReview } = await import('../src/broadcast/dj-agent/leanings-pass.js');
const { NO_AGENTIC_LEANINGS_INFLUENCE } = await import('../src/broadcast/dj-agent/schemas.js');
import type { LeaningsRoute } from '../src/broadcast/dj-agent/leanings-pass.js';
import type { PickResolution } from '../src/broadcast/dj-agent/leanings-review.js';

const baseline = { id: 'baseline', title: 'Base Line', artist: 'First Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 120, key: '8A', instrumental: false };
const synth = { id: 'synth', title: 'Glass Pulse', artist: 'Second Artist', energy: 'medium', moods: ['reflective'], genre: 'Synth-Pop', bpm: 121, key: '8A', instrumental: false };
const plain = { id: 'plain', title: 'Plain Song', artist: 'Third Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 122, key: '8A', instrumental: false };
const seen = new Map([baseline, synth, plain].map((track) => [track.id, track]));
const editorialLeanings = { host: 'Favour synth-pop and warm voices.', guest: null, promptValue: 'Host: Favour synth-pop and warm voices.' };
const goodReason = 'its glassy synth pulse keeps the reflective sequence moving with a brighter edge';

function route(kind: LeaningsRoute['kind']): LeaningsRoute {
  return {
    kind,
    telemetry: {},
    label: kind === 'djShortlistLeaningsReview' ? 'Musical Leanings review' : 'Agentic Leanings review',
    fallback: 'using the baseline',
    failureEvent: kind === 'djShortlistLeaningsReview' ? 'shortlist.leaningsReviewFailed' : 'pick.leaningsReviewFailed',
    failureFields: kind === 'djAgentLeaningsReview' ? { agent: 'pick' } : undefined,
    replacementReason: (replacement, leaningsReason) => `[${kind}] ${replacement.id}: ${leaningsReason}`,
  };
}

async function run(answer: unknown, kind: LeaningsRoute['kind'] = 'djAgentLeaningsReview', overrides: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const logLines: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const resolution: PickResolution = {};
  const result = await runLeaningsReview({
    song: baseline,
    object: { id: baseline.id, reason: 'baseline reason', transition: 'normal' },
    seen,
    editorialLeanings,
    djName: 'Mara Vex',
    context: { link: 'No link airs for this pick.', recentTransitions: ['washout'] },
    resolution,
    route: route(kind),
    review: async (request) => {
      prompts.push(request.prompt);
      assert.equal(request.kind, kind);
      assert.equal(request.temperature, 0, 'the private review samples deterministically');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: (line) => logLines.push(line),
    logEvent: (event, fields) => events.push([event, fields]),
    ...overrides,
  });
  return { result, resolution, prompts, logLines, events };
}

test('a verified replacement swaps the track, takes the route wording and a fresh transition', async () => {
  const { result, resolution, prompts } = await run({
    selectedId: 'synth', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: 'blend',
  });
  assert.equal(result.song.id, 'synth');
  assert.equal(result.object.id, 'synth');
  assert.equal(result.object.transition, 'blend', 'the replacement chooses its own transition');
  assert.match(result.object.reason, /^\[djAgentLeaningsReview\] synth: Mara Vex chose “Glass Pulse”/);
  assert.equal(result.reviewed, true);
  assert.equal(resolution.leaningsReview?.outcome, 'replaced');
  assert.equal(resolution.leaningsReview?.leaningsBasis, 'synth-pop');
  assert.equal(resolution.leaningsReview?.leaningsSource, 'host');
  assert.equal(resolution.leaningsReview?.baselineId, 'baseline');
  assert.match(prompts[0], /"recentTransitions"/, 'the transition ledger reaches the review');
});

test('both routes send the review the identical prompt, host/guest split included', async () => {
  const answer = { selectedId: 'baseline', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: goodReason, transition: null };
  const agentic = await run(answer, 'djAgentLeaningsReview');
  const shortlist = await run(answer, 'djShortlistLeaningsReview');
  assert.equal(agentic.prompts[0], shortlist.prompts[0]);
  assert.match(agentic.prompts[0], /"hostLeaningsOptions"/);
  assert.match(agentic.prompts[0], /"guestLeaningsOptions"/);
});

test('keeping the baseline leaves the pick untouched but records the review', async () => {
  const { result, resolution } = await run({
    selectedId: 'baseline', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: goodReason, transition: 'blend',
  });
  assert.equal(result.song, baseline);
  assert.equal(result.object.reason, 'baseline reason');
  assert.equal(result.object.transition, 'normal', 'a kept pick keeps its own transition');
  assert.equal(result.reviewed, true);
  assert.equal(resolution.leaningsReview?.outcome, 'kept');
  assert.equal(resolution.leaningsReview?.leaningsBasis, null);
});

test('an id outside the reviewed set is rejected and logged in the route wording', async () => {
  const { result, resolution, logLines } = await run(
    { selectedId: 'invented', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: null },
    'djShortlistLeaningsReview',
  );
  assert.equal(result.song, baseline);
  assert.equal(resolution.leaningsReview?.outcome, 'invalid');
  assert.equal(resolution.leaningsReview?.rejectionReason, 'unknown-candidate');
  assert.equal(resolution.leaningsReview?.proposedReplacementId, 'invented');
  assert.deepEqual(logLines, ['Musical Leanings review rejected (unknown-candidate) — using the baseline']);
});

test('a replacement without supported evidence is refused', async () => {
  const { result, resolution } = await run({
    selectedId: 'plain', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: null,
  });
  assert.equal(result.song, baseline);
  assert.equal(resolution.leaningsReview?.outcome, 'invalid');
  assert.equal(resolution.leaningsReview?.rejectionReason, 'basis-not-supported-by-candidate');
});

test('a failed review keeps the baseline, spends no step and emits the route failure event', async () => {
  const { result, resolution, events, logLines } = await run(new Error('provider down'));
  assert.equal(result.song, baseline);
  assert.equal(result.reviewed, false);
  assert.equal(resolution.leaningsReview?.outcome, 'failed');
  assert.equal(events[0][0], 'pick.leaningsReviewFailed');
  assert.equal(events[0][1].agent, 'pick');
  assert.equal(events[0][1].candidates, 3);
  assert.deepEqual(logLines, ['Agentic Leanings review failed — using the baseline']);
});

test('no Leanings, or nothing to compare, means no model call at all', async () => {
  const noLeanings = await run(null, 'djAgentLeaningsReview', { editorialLeanings: { host: null, guest: null, promptValue: null } });
  assert.equal(noLeanings.prompts.length, 0);
  assert.equal(noLeanings.resolution.leaningsReview?.outcome, 'not-run');
  const alone = await run(null, 'djAgentLeaningsReview', { seen: new Map([[baseline.id, baseline]]) });
  assert.equal(alone.prompts.length, 0);
  assert.equal(alone.result.reviewed, false);
});
