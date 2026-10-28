// The Era tab's year fields (era-year.ts) and its per-track search links
// (era-search.ts).
//
// Run: npm test -- era-year

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERA_YEAR_MIN, eraYearInputProps, eraYearInvalid, eraYearMax, parseEraYear } from './era-year';
import { buildSearchUrl, isSearchEngine } from './era-search';

test('a year is four digits between 1900 and this year, and nothing else', () => {
  const now = new Date().getFullYear();
  assert.equal(ERA_YEAR_MIN, 1900);
  assert.equal(eraYearMax(), now);
  assert.equal(parseEraYear('1971'), 1971);
  assert.equal(parseEraYear(' 2019 '), 2019);
  assert.equal(parseEraYear(String(now)), now);
  for (const bad of ['20009', '1899', '-1971', '0', '197', String(now + 1), '19.5', '1e3', 'abcd']) {
    assert.equal(parseEraYear(bad), null, bad);
    assert.equal(eraYearInvalid(bad), true, bad);
  }
  assert.equal(eraYearInvalid(''), false, 'an empty field is not an error, it is not saved');
});

test('the field carries the range, and an empty field nudged by the arrows starts at the album year', () => {
  let set = '';
  const p = eraYearInputProps('', 1994, v => { set = v; });
  assert.equal(p.min, 1900);
  assert.equal(p.max, new Date().getFullYear());
  assert.equal(p.placeholder, '1994');
  let prevented = false;
  p.onKeyDown({ key: 'ArrowUp', preventDefault: () => { prevented = true; } } as never);
  assert.equal(set, '1994');
  assert.equal(prevented, true);
  // The spinner on an empty field lands on the range's end: the album year instead.
  p.onChange({ currentTarget: { value: '1900' }, nativeEvent: {} } as never);
  assert.equal(set, '1994');
  // Typing is taken as typed, cut at four digits.
  p.onChange({ currentTarget: { value: '200099' }, nativeEvent: { inputType: 'insertText' } } as never);
  assert.equal(set, '2000');
  // A field that already holds a year is not reset.
  const q = eraYearInputProps('1980', 1994, v => { set = v; });
  q.onKeyDown({ key: 'ArrowUp', preventDefault: () => assert.fail('must not prevent') } as never);
});

test('the search link carries artist, title and "release date"; directory sites get the names only', () => {
  assert.equal(
    buildSearchUrl('google', 'Ben Böhmer Begin Again release date'),
    'https://www.google.com/search?q=Ben%20B%C3%B6hmer%20Begin%20Again%20release%20date',
  );
  assert.equal(buildSearchUrl('discogs', 'Ben Böhmer Begin Again release date'), 'https://www.discogs.com/search/?type=all&q=Ben%20B%C3%B6hmer%20Begin%20Again');
  assert.equal(isSearchEngine('qwant'), true);
  assert.equal(isSearchEngine('altavista'), false);
});
