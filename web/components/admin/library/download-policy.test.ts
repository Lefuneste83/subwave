import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONFIRM_BYTES, CONFIRM_TRACKS, browseFilterParams, confirmText, downloadBody, downloadCount,
  downloadLabel, downloadTitle, fmtBytes, needsConfirm, sizeText, type BrowseFilterState,
} from './download-policy';
import { DownloadControl } from './DownloadButton';

const NONE: BrowseFilterState = {
  moods: [], energy: 'any', vocal: 'any', genre: '', yearFrom: '', yearTo: '', q: '', sort: 'artist',
};

test('the label counts the ticked rows, else the whole list', () => {
  assert.equal(downloadCount(1, 248), 1);
  assert.equal(downloadCount(0, 248), 248);
  assert.equal(downloadCount(0, null), null);
  assert.equal(downloadLabel(1, false), 'Download 1 track');
  assert.equal(downloadLabel(248, false), 'Download 248 tracks');
  assert.equal(downloadLabel(12345, false), 'Download 12,345 tracks');
  assert.equal(downloadLabel(null, false), 'Download');
  assert.equal(downloadLabel(0, false), 'Download');
  assert.equal(downloadLabel(248, true), 'Preparing…');
});

test('ticked rows go as ids; none sends the list filter, paging aside', () => {
  assert.deepEqual(downloadBody(['b', 'a'], { kind: 'browse', filter: NONE }), { ids: ['b', 'a'] });
  const f: BrowseFilterState = {
    moods: ['calm', 'dreamy'], energy: 'low', vocal: 'instrumental', genre: 'Jazz',
    yearFrom: '1990', yearTo: '1999', q: ' artist:Ane ', sort: 'title',
  };
  assert.deepEqual(downloadBody([], { kind: 'browse', filter: f }), {
    filter: {
      moods: 'calm,dreamy', energy: 'low', vocal: 'instrumental', genre: 'Jazz',
      yearFrom: '1990', yearTo: '1999', q: 'artist:Ane', sort: 'title',
    },
  });
  // The list's own request is built from the same parameters, in its old order.
  assert.equal(new URLSearchParams(browseFilterParams(f)).toString(),
    'moods=calm%2Cdreamy&energy=low&vocal=instrumental&genre=Jazz&yearFrom=1990&yearTo=1999&q=artist%3AAne&sort=title');
  assert.deepEqual(browseFilterParams(NONE), { sort: 'artist' });
});

test('a big download asks first: over 50 tracks or over 2 GB', () => {
  assert.equal(CONFIRM_TRACKS, 50);
  assert.equal(needsConfirm({ count: 50, bytes: 0 }), false);
  assert.equal(needsConfirm({ count: 51, bytes: 0 }), true);
  assert.equal(needsConfirm({ count: 2, bytes: CONFIRM_BYTES }), false);
  assert.equal(needsConfirm({ count: 2, bytes: CONFIRM_BYTES + 1 }), true);
});

test('the confirm states the count, the estimated size and the form', () => {
  assert.equal(fmtBytes(6.54 * 1024 ** 3), '6.5 GB');
  assert.equal(fmtBytes(40 * 1024 ** 2), '40 MB');
  assert.equal(sizeText({ count: 3, bytes: 0, unsized: 3 }), 'size unknown');
  assert.equal(sizeText({ count: 3, bytes: 3 * 1024 ** 3, unsized: 1 }), 'about 3.0 GB, plus 1 track of unknown size');
  assert.equal(
    confirmText({ path: '/x', count: 248, bytes: 6.1 * 1024 ** 3, unsized: 0, name: 'library-248-tracks-2026-11-23.zip', single: false }),
    '248 tracks, about 6.1 GB, as one zip (library-248-tracks-2026-11-23.zip). '
      + 'Your browser saves it as it arrives; the tracks come from the music server one at a time.',
  );
});

const render = (props: Parameters<typeof DownloadControl>[0]) =>
  renderToStaticMarkup(createElement(DownloadControl, props));

test('the button: count, accent while rows are ticked, disabled and relabelled while pending', () => {
  const idle = render({ count: 248, selectedCount: 0, pending: false, onClick: () => {} });
  assert.match(idle, /> Download 248 tracks<\/button>/);
  assert.match(idle, /border-ink/);
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /title="Download every track in this list, all pages/);

  const ticked = render({ count: 1, selectedCount: 1, pending: false, onClick: () => {} });
  assert.match(ticked, /> Download 1 track<\/button>/);
  assert.match(ticked, /bg-\[var\(--accent\)\]/);
  assert.match(ticked, /title="Download the 1 ticked track/);

  const pending = render({ count: 248, selectedCount: 0, pending: true, onClick: () => {} });
  assert.match(pending, /> Preparing…<\/button>/);
  assert.match(pending, /disabled=""/);

  // Nothing listed yet (or an empty list): nothing to press.
  assert.match(render({ count: null, selectedCount: 0, pending: false, onClick: () => {} }), /disabled=""/);
});

// ── The Liked list (Library → Tracks → Liked) ────────────────────────────────
test('liked: ticked rows go as ids; none sends the view\'s sort for every liked track', () => {
  assert.deepEqual(downloadBody(['x', 'y'], { kind: 'liked', sort: 'count' }), { ids: ['x', 'y'] });
  assert.deepEqual(downloadBody([], { kind: 'liked', sort: 'count' }), { liked: { sort: 'count' } });
  assert.deepEqual(downloadBody([], { kind: 'liked', sort: 'recent' }), { liked: { sort: 'recent' } });
});

test('liked: the label counts every liked track, and ticked rows override it', () => {
  // liked.total counts all pages, not the 50 on screen.
  assert.equal(downloadLabel(downloadCount(0, 312), false), 'Download 312 tracks');
  assert.equal(downloadLabel(downloadCount(3, 312), false), 'Download 3 tracks');
  assert.equal(downloadTitle(0, 'liked'),
    'Download every liked track, all pages (several come as one zip); tick rows to take only those');
  assert.equal(downloadTitle(3, 'liked'), downloadTitle(3, 'browse'));
  assert.match(downloadTitle(0, 'browse'), /^Download every track in this list/);

  const idle = render({ count: 312, selectedCount: 0, pending: false, onClick: () => {}, source: 'liked', sm: true });
  assert.match(idle, /> Download 312 tracks<\/button>/);
  assert.match(idle, /border-ink/);
  assert.match(idle, /title="Download every liked track, all pages/);
  assert.doesNotMatch(idle, /bg-\[var\(--accent\)\]/);
  const ticked = render({ count: 3, selectedCount: 3, pending: false, onClick: () => {}, source: 'liked', sm: true });
  assert.match(ticked, /> Download 3 tracks<\/button>/);
  assert.match(ticked, /bg-\[var\(--accent\)\]/);
  const pending = render({ count: 312, selectedCount: 0, pending: true, onClick: () => {}, source: 'liked', sm: true });
  assert.match(pending, /disabled=""/);
  assert.match(pending, /> Preparing…<\/button>/);
  // No liked track yet: nothing to take.
  assert.match(render({ count: 0, selectedCount: 0, pending: false, onClick: () => {}, source: 'liked' }), /disabled=""/);
});
