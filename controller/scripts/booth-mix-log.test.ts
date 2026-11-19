// The booth's mixing lines (kind `mix`: every Hot Mix seam planned or refused
// and why, stem blends, pick-time stems) outlive a restart in the day's events
// file, as `booth.mix`. The in-memory booth log keeps 200 lines and is lost on
// a controller restart, so an unsynced seam heard on air could only be
// reconstructed afterwards from grids and radio.log. Other booth kinds stay
// in memory only: they carry listener and speech detail the events file does
// not need.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-booth-mix-log-'));
process.env.STATE_DIR = root;

const { queue } = await import('../src/broadcast/queue.js');

test('a mix booth line is appended to the events file, other kinds are not', async () => {
  queue.log('mix', 'Hot Mix: plain crossfade "A" → "B" (tempo gap 7.1 % is past twice the 3 % sync limit)', { big: 'x'.repeat(10) });
  queue.log('dj', 'said something on air');
  const path = `${root}/logs/events-${new Date().toISOString().slice(0, 10)}.jsonl`;
  let lines: any[] = [];
  for (let i = 0; i < 50 && lines.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (existsSync(path)) lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const booth = lines.filter((e) => e.type?.startsWith('booth.'));
  assert.equal(booth.length, 1);
  assert.equal(booth[0].type, 'booth.mix');
  assert.match(booth[0].message, /plain crossfade "A" → "B" \(tempo gap 7\.1 %/);
  assert.equal(booth[0].big, undefined, 'meta stays in memory');
  assert.equal(queue.djLog[0].kind, 'dj', 'the in-memory booth still holds every kind');
  await removeTempDir(root);
});
