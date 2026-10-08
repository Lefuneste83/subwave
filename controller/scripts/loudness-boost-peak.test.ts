// A boost needs a known peak (music/mix.ts gainForLoudness, music/loudness.ts
// resolveGainDb).
//
// The boost cap alone is not a safety limit: with no peak the headroom check is
// skipped, so a track whose loudness reads quiet went up by the whole
// maxBoostDb (up to 12 dB) into the bus limiter. Both a ReplayGain tag without
// trackPeak and a measurement without peak_db reach that path. Now an unknown
// peak holds the boost at 0 dB, cuts still apply, and the drain says once per
// track why a quiet track was left where it was.
//
// Offline: every track object carries its own replayGain key, and the library
// is never loaded, so nothing reaches Subsonic or library.db.
// Run: `tsx scripts/loudness-boost-peak.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-boost-peak-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const loudness = await import('../src/music/loudness.js');

before(async () => {
  await settings.load();
});

beforeEach(async () => {
  loudness._resetBoostHeldNotesForTests();
  await settings.update({ loudness: { source: 'replaygain-then-measured', targetLufs: -14, maxBoostDb: 10 } });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a measured track with no peak is not boosted', async () => {
  const gain = await loudness.resolveGainDb({ id: 'm1', replayGain: null, loudnessLufs: -24, peakDb: null });
  assert.equal(gain, 0, 'wants +10, peak unknown → 0 dB');
});

test('a measured track with a peak is boosted up to its headroom', async () => {
  const gain = await loudness.resolveGainDb({ id: 'm2', replayGain: null, loudnessLufs: -24, peakDb: -7 });
  assert.equal(gain, 6, 'headroom to the -1 dBFS ceiling');
});

test('a ReplayGain tag with no trackPeak is not boosted', async () => {
  // trackGain +6 → the file sits at -24 LUFS; no peak anywhere.
  const gain = await loudness.resolveGainDb({ id: 'r1', replayGain: { trackGain: 6 }, loudnessLufs: null, peakDb: null });
  assert.equal(gain, 0);
});

test('a loud track with no peak is still turned down', async () => {
  const gain = await loudness.resolveGainDb({ id: 'c1', replayGain: null, loudnessLufs: -8, peakDb: null });
  assert.equal(gain, -6);
});

test('a held boost is reported once per track, with the gain it wanted', async () => {
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  const track = { id: 'w1', replayGain: null, loudnessLufs: -21.5, peakDb: null };
  await loudness.resolveGainDb({ ...track }, onWarn);
  await loudness.resolveGainDb({ ...track }, onWarn);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /no peak known for w1/);
  assert.match(warnings[0], /\+7\.5 dB/); // within the 10 dB cap
});

test('nothing is reported when nothing was held', async () => {
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  await loudness.resolveGainDb({ id: 'n1', replayGain: null, loudnessLufs: -24, peakDb: -20 }, onWarn); // boosted
  await loudness.resolveGainDb({ id: 'n2', replayGain: null, loudnessLufs: -8, peakDb: null }, onWarn); // cut
  await loudness.resolveGainDb({ id: 'n3', replayGain: null, loudnessLufs: -14, peakDb: null }, onWarn); // on target
  await loudness.resolveGainDb({ id: 'n4', replayGain: null, loudnessLufs: -24, peakDb: -0.5 }, onWarn); // no headroom
  await settings.update({ loudness: { maxBoostDb: 0 } });
  await loudness.resolveGainDb({ id: 'n5', replayGain: null, loudnessLufs: -24, peakDb: null }, onWarn); // cut-only station
  // With maxBoostDb 0 (n5) there was no boost to hold back either.
  assert.deepEqual(warnings, []);
});
