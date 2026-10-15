import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BackupRouteNote, { backupRouteTitle } from './BackupRouteNote';

const routing = {
  kind: 'exhausted' as const,
  since: 1_000_000,
  until: 1_000_000 + 5 * 60_000,
  provider: 'locca',
  model: 'locca:qwythos-9b',
};

test('while routed, the note names the backup in the subtitle form "provider / model"', () => {
  const html = renderToStaticMarkup(createElement(BackupRouteNote, { routing }));
  assert.match(html, /routed to backup locca \/ locca:qwythos-9b/);
});

test('the dot uses the theme accent, the colour of the Dash "On Air" LIVE lamp', () => {
  const html = renderToStaticMarkup(createElement(BackupRouteNote, { routing }));
  assert.match(html, /bg-\[var\(--accent\)\]/);
  assert.match(html, /aria-hidden="true"/, 'the dot is decoration; the words carry the meaning');
});

test('normal routing renders nothing, so the subtitle returns to its plain form', () => {
  assert.equal(renderToStaticMarkup(createElement(BackupRouteNote, { routing: null })), '');
  assert.equal(renderToStaticMarkup(createElement(BackupRouteNote, {})), '');
});

test('the tooltip gives the reason and the time left in the window', () => {
  assert.equal(
    backupRouteTitle(routing, routing.since + 60_000),
    'primary failing (5xx) — routing to the backup for about 4 more min, then the primary is tried again',
  );
  assert.match(backupRouteTitle({ ...routing, kind: 'unreachable' }, routing.since), /^primary unreachable/);
  assert.match(backupRouteTitle({ ...routing, kind: 'hung' }, routing.since), /^primary not answering/);
});

test('the tooltip never counts below one minute, and copes with a partial payload', () => {
  assert.match(backupRouteTitle(routing, routing.until - 1_000), /about 1 more min/);
  assert.equal(backupRouteTitle({ provider: 'locca' }), 'primary marked down — routing to the backup');
});
