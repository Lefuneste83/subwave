// settings.stationTabTitle — the player's browser-tab title switch (Settings →
// Station → "Use the station name as the browser tab title").
//
// Pins the properties that make it a setting and not a session toggle:
//  - OFF on a fresh install and on a settings.json written before the key.
//  - ON survives a COLD load (setCache(null) + load()): load() composes each
//    field explicitly, so a key missing there saves fine and then silently
//    reverts on the next restart (controller/CLAUDE.md, #1317/#1327).
//  - Only a real boolean is accepted by update(); a hand-edited non-boolean
//    on disk reads as OFF.
//  - It is postable through PUT/POST /settings (in SETTINGS_PATCH_KEYS).
//
// Run: npm test -- station-tab-title

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-tab-title-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { SETTINGS_PATCH_KEYS } = await import('../src/settings/patch-registry.js');

after(() => rmSync(root, { recursive: true, force: true }));

async function coldLoad() {
  setCache(null);
  return settings.load();
}

test('off by default on a fresh install', async () => {
  const s = await coldLoad();
  assert.equal(s.stationTabTitle, false);
});

test('on survives a restart (cold load)', async () => {
  await settings.update({ stationTabTitle: true });
  const s = await coldLoad();
  assert.equal(s.stationTabTitle, true);
  await settings.update({ stationTabTitle: false });
  assert.equal((await coldLoad()).stationTabTitle, false);
});

test('update() refuses a non-boolean', async () => {
  await assert.rejects(
    () => settings.update({ stationTabTitle: 'yes' } as never),
    /stationTabTitle must be a boolean/,
  );
});

test('a settings.json without the key, or with garbage, reads as off', async () => {
  await settings.update({ stationTabTitle: true });
  const file = join(root, 'settings.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  delete stored.stationTabTitle;
  writeFileSync(file, JSON.stringify(stored));
  assert.equal((await coldLoad()).stationTabTitle, false);
  stored.stationTabTitle = 'true';
  writeFileSync(file, JSON.stringify(stored));
  assert.equal((await coldLoad()).stationTabTitle, false);
});

test('postable from the admin settings form', () => {
  assert.ok(SETTINGS_PATCH_KEYS.includes('stationTabTitle'));
});
