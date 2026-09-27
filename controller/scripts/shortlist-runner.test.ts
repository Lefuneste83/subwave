import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShortlist, executeShortlistPlan, planShortlistSources, replayFixtureTrace } from '../src/music/shortlist.js';
import { pickerScope } from '../src/llm/tools.js';
import { resolvedLeaningsTieBreak, resolvedMusicalLeaningsFlag, shortlistPickPrompt, shortlistPickSchema, shortlistReasonForLeanings, shortlistSelectionReason } from '../src/music/dj-pick.js';

test('makes a redacted, replayable trace with source arguments and candidate ids', () => {
  const trace = replayFixtureTrace({
    currentTrack: { id: 'current', title: 'Current Song', artist: 'Current Artist', album: 'Album' },
    show: { id: 'show-1', name: 'Night Shift', genres: ['ambient'], filtersStrict: true },
    scope: pickerScope({
      recentIds: new Set(['recent-b', 'recent-a']),
      playlistTracks: [{ id: 'playlist-track', title: 'Never logged' }],
      audioWaypoint: [0.1, 0.2],
    }),
    toolCalls: [{
      name: 'tracksLikeThis', args: { songId: 'current' }, round: 2,
      result: { tracks: [{ id: 'candidate-a', title: 'Only the id survives' }] },
    }],
  });

  assert.deepEqual(trace.sourceCalls, [{
    source: 'tracksLikeThis', args: { songId: 'current' }, round: 2, candidateIds: ['candidate-a'],
  }]);
  assert.deepEqual(trace.scope.recentIds, ['recent-a', 'recent-b']);
  assert.deepEqual(trace.scope.playlistTrackIds, ['playlist-track']);
  assert.equal(trace.currentTrack.title, 'Current Song');
  assert.equal('title' in trace.sourceCalls[0], false);
});

test('cycles context, continuity, and exploration source lanes without adding sources', () => {
  const journey = planShortlistSources({
    scope: pickerScope({ audioWaypoint: [0.1] }),
    currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['celebratory'], energies: ['high'],
  }, new Set(['tracksTowardJourney', 'tracksByMood', 'tracksThatSoundLikeThis', 'tracksLikeThis']));
  assert.deepEqual(journey, [
    { source: 'tracksByMood', args: { mood: 'celebratory', energy: 'high' } },
    { source: 'tracksThatSoundLikeThis', args: { songId: 'seed' } },
    { source: 'tracksTowardJourney', args: {} },
  ]);

  const rotating = planShortlistSources({
    scope: pickerScope({ audioWaypoint: [0.1] }),
    currentTrackId: 'seed', discoveryPasses: 5,
    moods: ['celebratory'], energies: ['high'],
  }, new Set([
    'tracksTowardJourney', 'tracksByMood',
    'tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs',
    'deepCuts', 'recentlyAdded', 'starredSongs', 'randomSongs',
  ]));
  assert.equal(rotating.length, 5);
  assert.ok(['tracksTowardJourney', 'tracksByMood'].includes(rotating[0].source));
  assert.ok(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs'].includes(rotating[1].source));
  assert.ok(['deepCuts', 'recentlyAdded', 'starredSongs', 'randomSongs'].includes(rotating[2].source));
  assert.ok(['tracksTowardJourney', 'tracksByMood'].includes(rotating[3].source));
  assert.ok(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs'].includes(rotating[4].source));
  assert.notEqual(rotating[0].source, rotating[3].source);
  assert.notEqual(rotating[1].source, rotating[4].source);

  const strictPlaylist = planShortlistSources({
    scope: pickerScope({ playlistTracks: [{ id: 'in-show' }], playlistLock: new Set(['in-show']) }),
    currentTrackId: 'seed', discoveryPasses: 5,
    moods: ['reflective'], energies: ['low'], explore: true,
  }, new Set(['showPlaylistTracks', 'tracksByMood', 'deepCuts']));
  assert.deepEqual(strictPlaylist.map((call) => call.source), [
    'showPlaylistTracks', 'deepCuts', 'deepCuts', 'showPlaylistTracks', 'deepCuts',
  ]);

  const empty = planShortlistSources({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'],
  }, new Set(['tracksByMood']));
  assert.deepEqual(empty, [
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
  ]);
});

test('native builder plans from source-owned availability before execution', async () => {
  // A no-index scope still keeps its usable mood source and an available
  // exploration source, without logging unavailable similarity probes.
  const result = await buildShortlist({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'],
  });
  assert.ok(result.sourceRuns.length > 0);
  assert.ok(result.sourceRuns.some((run) => run.source === 'tracksByMood'));
  assert.ok(result.sourceRuns.every((run) => run.status !== 'unavailable'));
});

test('DJ shortlist selection accepts only supplied ids and keeps provenance out of its reason', () => {
  const schema = shortlistPickSchema(['candidate-a', 'candidate-b']);
  assert.equal(schema.safeParse({
    id: 'candidate-a', selectionReason: 'One by Artist A brings a warmer texture after the opener.', usedMusicalLeanings: false, say: null, transition: null,
  }).success, true);
  // modelTolerant repairs missing nullable fields for less capable providers;
  // the final controller gate below still rejects true without real evidence.
  assert.equal(schema.safeParse({
    id: 'invented', selectionReason: 'not allowed', usedMusicalLeanings: false, say: null, transition: null,
  }).success, false);
  const prompt = shortlistPickPrompt([{ id: 'candidate-a', title: 'One', shortlistSources: ['tracksByMood'] }], {
    currentTrack: { id: 'current', title: 'Current', artist: 'Artist' },
    precedingTrack: { id: 'prior', title: 'Prior', artist: 'Earlier Artist' },
    transition: { recentChoices: ['normal', 'sweep'], guidance: 'Choose deliberately.' },
    journey: { direction: 'Move toward the destination.', targetBpm: 116, targetKey: '8A' },
    curatedPlaylist: { mode: 'soft' },
    link: 'A separate safe link may air for this pick.',
  }, {
    host: 'Favour patient dub.',
    guest: { guest: { id: 'guest-1', name: 'Carrie Marshall' }, musicalLeanings: 'Favour unexpected rock records.' },
    promptValue: 'Host: Favour patient dub.\nGuest (Carrie Marshall, secondary): Favour unexpected rock records.',
  });
  assert.match(prompt, /candidate-a/);
  assert.match(prompt, /Track Shortlist/);
  const payload = JSON.parse(prompt.split('\n\nChoose one id')[0]);
  assert.deepEqual(payload.context, {
    currentTrack: { id: 'current', title: 'Current', artist: 'Artist' },
    precedingTrack: { id: 'prior', title: 'Prior', artist: 'Earlier Artist' },
    transition: { recentChoices: ['normal', 'sweep'], guidance: 'Choose deliberately.' },
    journey: { direction: 'Move toward the destination.', targetBpm: 116, targetKey: '8A' },
    curatedPlaylist: { mode: 'soft' },
    link: 'A separate safe link may air for this pick.',
    musicalLeanings: 'Host: Favour patient dub.\nGuest (Carrie Marshall, secondary): Favour unexpected rock records.',
  });
  assert.ok(payload.context.musicalLeanings.indexOf('Host:') < prompt.indexOf('"shortlist"'));
  assert.match(prompt, /soft editorial preference among already eligible/i);
  assert.match(prompt, /strongly prefer candidates whose shortlistSources contain "showPlaylistTracks"/i);
  assert.match(prompt, /transition context is supplied/i);
  assert.doesNotMatch(prompt, /leaningsTieBreak/i);
  assert.equal(resolvedMusicalLeaningsFlag({ host: 'x', guest: null, promptValue: 'Host: x' }, true), true);
  assert.equal(resolvedMusicalLeaningsFlag(null, true, 'plain reason'), false);
});

test('shortlist presentation never attaches one track\'s note to another track', () => {
  const selected = { id: 'sam', title: 'How Do You Sleep?', artist: 'Sam Smith' };
  assert.equal(
    shortlistSelectionReason(selected, 'Porcupine Tree — Of the New Day keeps the atmosphere moving.'),
    'Selected "How Do You Sleep? by Sam Smith" from the eligible shortlist.',
  );
  assert.equal(
    shortlistSelectionReason(selected, 'Sam Smith — How Do You Sleep? keeps the atmosphere moving.'),
    'Sam Smith — How Do You Sleep? keeps the atmosphere moving.',
  );
  assert.equal(
    shortlistSelectionReason(
      { id: 'gabriel', title: 'Digging in the Dirt', artist: 'Peter Gabriel' },
      'Peter Gabriel fits well with the current flow, and',
    ),
    '“Digging in the Dirt” by Peter Gabriel — fits well with the current flow.',
  );
  assert.equal(
    shortlistSelectionReason(
      { id: 'qualls', title: 'Black Qualls', artist: 'Thundercat feat. Steve Lacy, Steve Arrington & Childish Gambino' },
      "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
    ),
    "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
  );
});

test('Shortlist Leanings provenance requires an explicit decision', () => {
  assert.equal(
    resolvedMusicalLeaningsFlag({ host: 'Favour patient dub.', guest: null, promptValue: 'Host: Favour patient dub.' }, false, 'warm vocal and melodic hook'),
    false,
  );
  assert.equal(
    resolvedMusicalLeaningsFlag({ host: 'Favour patient dub.', guest: null, promptValue: 'Host: Favour patient dub.' }, true, 'warm vocal and melodic hook'),
    true,
  );
  assert.equal(
    resolvedMusicalLeaningsFlag({ host: 'Favour patient dub.', guest: null, promptValue: 'Host: Favour patient dub.' }, false, 'warm vocal and melodic hook'),
    false,
  );
  assert.equal(
    resolvedMusicalLeaningsFlag(null, true, 'warm vocal and melodic hook'),
    false,
  );
  assert.equal(
    resolvedMusicalLeaningsFlag({ host: 'Favour patient dub.', guest: null, promptValue: 'Host: Favour patient dub.' }, true, null),
    true,
  );
  assert.equal(
    resolvedMusicalLeaningsFlag({ host: 'Favour patient dub.', guest: null, promptValue: 'Host: Favour patient dub.' }, true, 'energy'),
    true,
  );
});

test('Shortlist keeps natural claimed Leanings reasons and removes unclaimed ones', () => {
  const song = { artist: 'Prince', title: '1999' };
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', false, song),
    'Prince — 1999: selected for its fit with the current musical flow.',
  );
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', true, song),
    'Prince - 1999 fits because the DJ has a broad alternative taste.',
  );
  assert.equal(
    shortlistReasonForLeanings('Blood Orange - Charcoal Baby matches Carol’s preference for atmospheric tracks.', false, { artist: 'Blood Orange', title: 'Charcoal Baby' }),
    'Blood Orange — Charcoal Baby: selected for its fit with the current musical flow.',
  );
});

test('replays a source plan, keeping the picker accumulator as the source of truth', async () => {
  const seen = new Map<string, any>();
  const tools = {
    energy: {
      inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      execute: async () => {
        seen.set('a', { id: 'a', title: 'One' });
        seen.set('b', { id: 'b', title: 'Two' });
        return [{ id: 'a' }, { id: 'b' }];
      },
    },
    duplicate: {
      inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      execute: async () => [{ id: 'a' }],
    },
  };

  const result = await executeShortlistPlan(tools, seen, [
    { source: 'energy', args: { energy: 'high' } },
    { source: 'duplicate', args: {} },
    { source: 'unavailable', args: {} },
  ]);

  assert.equal(result.uniqueCandidates, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['a', 'b']);
  assert.deepEqual(result.candidates[0].shortlistSources, ['energy']);
  assert.deepEqual(result.sourceRuns.map((run) => [run.source, run.status, run.returned, run.accepted]), [
    ['energy', 'ok', 2, 2],
    ['duplicate', 'ok', 1, 0],
    ['unavailable', 'unavailable', 0, 0],
  ]);
});

test('records invalid input and source errors without abandoning later sources', async () => {
  const seen = new Map<string, any>();
  const tools = {
    invalid: {
      inputSchema: { safeParse: () => ({ success: false, error: { issues: [{ message: 'query required' }] } }) },
      execute: async () => { throw new Error('must not run'); },
    },
    failed: {
      execute: async () => { throw new Error('library offline'); },
    },
  };

  const result = await executeShortlistPlan(tools, seen, [
    { source: 'invalid', args: {} },
    { source: 'failed', args: {} },
  ]);

  assert.deepEqual(result.sourceRuns.map((run) => [run.status, run.error]), [
    ['invalid', 'query required'],
    ['error', 'library offline'],
  ]);
});
