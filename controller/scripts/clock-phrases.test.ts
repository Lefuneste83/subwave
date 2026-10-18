// Pins the clock-phrase regexes, circular-distance arithmetic, prompt-memory
// stripping and air-time reconciliation so that small-model drift ("just after
// ten" copied into a line aired an hour later) stays caught by CI.
// Run: npm test -- clock-phrases

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findClockPhrases,
  stripClockPhrases,
  clockOffMinutes,
  reconcileClockPhrases,
  isEnglishSpeech,
  CLOCK_CHECK_EXEMPT_KINDS,
} from '../src/broadcast/clock-phrases.js';

test('find: "just after ten" at 11:48 is off by 83', () => {
  const phrases = findClockPhrases('just after ten');
  assert.equal(phrases.length, 1);
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [600, 625]);
  const off = clockOffMinutes(phrases[0], '11:48');
  assert.equal(off, 83);
});

test('find: "half past seven" yields ONE phrase (pattern a)', () => {
  const phrases = findClockPhrases('half past seven');
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text.toLowerCase(), 'half past seven');
  // B=420, window [440, 460]
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [440, 460]);
});

test('find: "It\'s quarter to nine" -> window [520, 530]', () => {
  const phrases = findClockPhrases("It's quarter to nine");
  assert.equal(phrases.length, 1);
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [520, 530]);
});

test('find: "approaching noon" -> [-25,0]; 11:50 off 0; 12:10 off 10', () => {
  const phrases = findClockPhrases('approaching noon');
  assert.equal(phrases.length, 1);
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [-25, 0]);
  assert.equal(clockOffMinutes(phrases[0], '11:50'), 0);
  assert.equal(clockOffMinutes(phrases[0], '12:10'), 10);
});

test('find: album title 5:55 not a phrase; "it\'s 9:45 now" is', () => {
  assert.equal(findClockPhrases('drawn from the 2006 album 5:55.').length, 0);
  assert.equal(findClockPhrases('"Night Time Intermission" from 5:55').length, 0);
  const phrases = findClockPhrases("it's 9:45 now");
  assert.equal(phrases.length, 1);
});

test('find: "hunched over my desk at 2AM" -> no; "it\'s 2am here" -> one', () => {
  assert.equal(findClockPhrases('hunched over my desk at 2AM').length, 0);
  const phrases = findClockPhrases("it's 2am here");
  assert.equal(phrases.length, 1);
});

test('find: inside quotes -> no phrase', () => {
  assert.equal(findClockPhrases('the song "Half Past Ten"').length, 0);
});

test('strip: production examples and identity', () => {
  assert.equal(
    stripClockPhrases(
      "The Free Electron rolls through Plakias just after ten on a Monday, and right now we're diving in."
    ),
    "The Free Electron rolls through Plakias on a Monday, and right now we're diving in."
  );
  assert.equal(
    stripClockPhrases("Tuesday at half-past eleven on The Free Electron, I'm vibrating."),
    'Tuesday on The Free Electron, I\'m vibrating.'
  );
  const plain = 'Hello world, no clock here.';
  assert.equal(stripClockPhrases(plain), plain);
});

test('reconcile keep: within tolerance leaves text unchanged', () => {
  const r = reconcileClockPhrases("It's just after ten on a Monday.", {
    airHhmm: '10:12',
    supplied: 'just after 10am',
  });
  assert.equal(r.text, "It's just after ten on a Monday.");
  assert.equal(r.changes.length, 0);
});

test('reconcile replace: production case 12 Oct 11:48', () => {
  const r = reconcileClockPhrases(
    'The Free Electron rolls through Plakias just past ten on a Monday.',
    { airHhmm: '11:48', supplied: 'approaching noon' }
  );
  assert.equal(
    r.text,
    'The Free Electron rolls through Plakias approaching noon on a Monday.'
  );
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes[0], { from: 'just past ten', to: 'approaching noon', offMin: 83 });
});

test('reconcile replace at sentence start capitalises', () => {
  const r = reconcileClockPhrases(
    'Just after two on a proper Monday, and here we go.',
    { airHhmm: '15:15', supplied: 'around half past 3pm' }
  );
  assert.ok(r.text.startsWith('Around half past 3pm on a proper Monday'));
  assert.equal(r.changes.length, 1);
});

test('reconcile drop: removes sentence when no supplied', () => {
  const r = reconcileClockPhrases(
    'Southern Star Plakias Radio. It is just past four on a proper Monday.',
    { airHhmm: '16:56', supplied: null }
  );
  assert.equal(r.text, 'Southern Star Plakias Radio.');
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].to, null);
});

test('reconcile drop-all: only sentence removed -> empty', () => {
  const r = reconcileClockPhrases('Just after two on a proper Monday.', {
    airHhmm: '09:00',
    supplied: null,
  });
  assert.equal(r.text, '');
});

test('reconcile: no airHhmm but supplied given -> replaces (off null)', () => {
  const r = reconcileClockPhrases('It is half past four right now.', {
    airHhmm: null,
    supplied: 'around half past 9pm',
  });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].offMin, null);
  assert.ok(r.text.includes('around half past 9pm'));
});

test('isEnglishSpeech: accepted and rejected languages', () => {
  assert.equal(isEnglishSpeech(undefined), true);
  assert.equal(isEnglishSpeech(''), true);
  assert.equal(isEnglishSpeech('en'), true);
  assert.equal(isEnglishSpeech('en-GB'), true);
  assert.equal(isEnglishSpeech('English'), true);
  assert.equal(isEnglishSpeech('fr'), false);
  assert.equal(isEnglishSpeech('Greek'), false);
  assert.equal(isEnglishSpeech('el'), false);
});

test('CLOCK_CHECK_EXEMPT_KINDS contains hourly-check and remember', () => {
  assert.ok(CLOCK_CHECK_EXEMPT_KINDS.has('hourly-check'));
  assert.ok(CLOCK_CHECK_EXEMPT_KINDS.has('remember'));
});

// Added in review: a wrong edit changes a true line, so the phrases that only
// LOOK like a clock must stay untouched.
test('find: an hour word followed by a quantity is not a clock', () => {
  for (const line of [
    'Back after two years away, this one still hits.',
    'Approaching ten thousand plays on this station.',
    'Released just after one decade of silence.',
    'The record went quiet after three albums.',
  ]) assert.deepEqual(findClockPhrases(line), [], line);
});

test('find: the production phrases still match with the follower guard', () => {
  for (const line of [
    'The Free Electron rolls through Plakias just after ten on a Monday.',
    'It is just past four.',
    'Good morning, just past seven, and the café is full.',
    'approaching noon here in Crete',
    "It's coming up to eleven o'clock",
  ]) assert.equal(findClockPhrases(line).length, 1, line);
});

test('find: a digit run is not split into an hour ("25pm" is not "5pm")', () => {
  assert.deepEqual(findClockPhrases("it's 25pm"), []);
});

// Production lines a replay over 9 Sep–16 Oct would have changed although
// they were true: neither states the time now.
test('find: a bare "after midnight" is a stretch of the night, not a clock', () => {
  assert.deepEqual(findClockPhrases('it is Saturday after midnight on Friday Drive'), []);
  assert.equal(findClockPhrases('it is just after midnight on Friday Drive').length, 1);
});

test('T1 find: half-past midnight is a clock phrase', () => {
  const phrases = findClockPhrases('it is half-past midnight on a Sunday here');
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text, 'half-past midnight');
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [20, 40]);
});

test('T2 find: half past noon', () => {
  const phrases = findClockPhrases('half past noon');
  assert.equal(phrases.length, 1);
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [20, 40]);
});

test('T3 find: quarter past midnight', () => {
  const phrases = findClockPhrases("It's a quarter past midnight.");
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text, 'quarter past midnight');
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [10, 20]);
});

test('T4 find: quarter to midnight', () => {
  const phrases = findClockPhrases('quarter to midnight');
  assert.equal(phrases.length, 1);
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [-20, -10]);
});

test('T5 find: deictic "it is past midnight"', () => {
  const phrases = findClockPhrases('It is past midnight on a Cretan Sunday, and we turn to Lambchop.');
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text, 'past midnight');
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [0, 59]);
});

test('T6 find: "it\'s gone midnight" and "it is now past noon"', () => {
  const a = findClockPhrases("it's gone midnight here");
  assert.equal(a.length, 1);
  assert.equal(a[0].text, 'gone midnight');
  const b = findClockPhrases('it is now past noon');
  assert.equal(b.length, 1);
  assert.equal(b[0].text, 'past noon');
});

test('T7 find: "it is just past midnight" yields exactly ONE phrase', () => {
  const phrases = findClockPhrases('it is just past midnight');
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text, 'just past midnight');
  assert.deepEqual([phrases[0].lo, phrases[0].hi], [0, 25]);
});

test('T8 find: bare after/past midnight with no deictic anchor stays unmatched', () => {
  assert.deepEqual(findClockPhrases('it is Saturday after midnight on Friday Drive'), []);
  assert.deepEqual(findClockPhrases('we play records long past midnight'), []);
  assert.deepEqual(findClockPhrases('music after midnight'), []);
});

test('T9 reconcile: replace deictic "past midnight" at 03:09', () => {
  const r = reconcileClockPhrases(
    'It is past midnight on a Cretan Sunday, and we turn to Lambchop.',
    { airHhmm: '03:09', supplied: 'just after 3am' }
  );
  assert.equal(r.text, 'It is just after 3am on a Cretan Sunday, and we turn to Lambchop.');
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes[0], { from: 'past midnight', to: 'just after 3am', offMin: 130 });
});

test('T10 reconcile keep: "past midnight" at 00:41 within tolerance', () => {
  const r = reconcileClockPhrases(
    'It is past midnight on a Cretan Sunday, and we turn to Lambchop.',
    { airHhmm: '00:41', supplied: 'just after 3am' }
  );
  assert.equal(r.text, 'It is past midnight on a Cretan Sunday, and we turn to Lambchop.');
  assert.deepEqual(r.changes, []);
});

test('T11 reconcile keep: "half-past midnight" at 00:43 under tolerance', () => {
  const r = reconcileClockPhrases(
    'it is half-past midnight on a Sunday here',
    { airHhmm: '00:43', supplied: 'approaching 1am' }
  );
  assert.equal(r.text, 'it is half-past midnight on a Sunday here');
  assert.deepEqual(r.changes, []);
});

test('T12 strip: half-past midnight removed', () => {
  assert.equal(
    stripClockPhrases('it is half-past midnight on a Sunday here'),
    'it is on a Sunday here'
  );
});

test('find: a time the line refers back or ahead to is not the time now', () => {
  assert.deepEqual(findClockPhrases('It has been humming through the show since half past seven; now it plays.'), []);
  assert.deepEqual(findClockPhrases('Stay with us until nine o\'clock.'), []);
});

test('find: production phrases followed by a clause word still match', () => {
  for (const line of [
    "it's that awkward Wednesday hour just past six where the light fades",
    'this Monday just past three finds us chasing neon ghosts',
    'Southern Star Plakias | It is just past six | Tom Avro: exactly',
  ]) assert.equal(findClockPhrases(line).length, 1, line);
  // ...while a time stated as a compound minute is left to the reader.
  assert.deepEqual(findClockPhrases('It is just past four-thirty, and the world is quiet.'), []);
});

