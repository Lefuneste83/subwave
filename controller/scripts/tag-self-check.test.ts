// The propagation self-check (music/tag-library/self-check.ts), which a
// tagging run now lets run alongside the acoustic analysis.
//
// Pinned here:
//   - it reads its sample's stored truth when it is called: a tag rewritten
//     while it votes does not change what it scores against;
//   - with yieldBetweenVotes it hands the event loop back between votes (a
//     timer keeps firing while it runs), and without it it votes in one go,
//     as before;
//   - it writes nothing and never throws (a vote that throws is logged).
// Run: `npm test -- tag-self-check`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-self-check-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const { propagationSelfCheck, SELF_CHECK_SAMPLE } = await import('../src/music/tag-library/self-check.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => {
  db.close();
  await removeTempDir(dir);
});

const N = 40;
for (let i = 0; i < N; i++) {
  db.upsertTrackMeta(`t${i}`, { title: `T${i}`, artist: 'A', album: 'B', duration: 200 } as never);
  db.upsertTrackTags(`t${i}`, { moods: ['happy'], energy: 'high', source: 'llm', confidence: 1, promptHash: 'h', model: 'm' } as never);
  // The sample is drawn from tracks with a text vector (KNN needs one).
  db.getDb()!.prepare('INSERT INTO track_vectors (id, embedding) VALUES (?, ?)')
    .run(`t${i}`, Buffer.from(new Float32Array(8).fill(i + 1).buffer));
}

const okVote = () => ({ moods: ['happy'], energy: 'high', confidence: 0.9, votingNeighbours: 5 }) as never;

// The check returns what the run log prints for its step (a summary, a skip
// or a failure), and prints nothing itself.
async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let result: unknown;
  try { result = await fn(); } finally { console.log = log; }
  assert.deepEqual(lines, [], 'the check prints nothing itself');
  return Object.values(result as Record<string, string>);
}

test('the truth is read when the check starts, not while it votes', async () => {
  let votes = 0;
  const lines = await capture(() => propagationSelfCheck(() => {
    votes += 1;
    // Rewritten mid-check: the scored truth must not follow.
    if (votes === 1) for (let i = 0; i < N; i++) db.upsertTrackTags(`t${i}`, { moods: ['sad'], energy: 'low', source: 'llm', confidence: 1, promptHash: 'h', model: 'm' } as never);
    return okVote();
  }, 0.35, { yieldBetweenVotes: true }));
  assert.equal(votes, Math.min(SELF_CHECK_SAMPLE, N));
  const summary = lines[0] ?? '';
  assert.match(summary, /moods match 100% and energy 100%/, `scored against the truth read at the start: ${summary}`);
  for (let i = 0; i < N; i++) db.upsertTrackTags(`t${i}`, { moods: ['happy'], energy: 'high', source: 'llm', confidence: 1, promptHash: 'h', model: 'm' } as never);
});

test('alongside the analysis it yields between votes; on its own it votes in one go', async () => {
  for (const yieldBetweenVotes of [true, false]) {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    let ticksAtLastVote = -1;
    await capture(() => propagationSelfCheck(() => {
      const end = Date.now() + 2;
      while (Date.now() < end) { /* a vote's CPU */ }
      ticksAtLastVote = ticks;
      return okVote();
    }, 0.35, { yieldBetweenVotes }));
    clearInterval(timer);
    if (yieldBetweenVotes) assert.ok(ticksAtLastVote > 5, `the loop ran between votes (${ticksAtLastVote} ticks)`);
    else assert.equal(ticksAtLastVote, 0, 'no tick while voting in one go');
  }
});

test('a vote that throws is logged, never thrown, and nothing is written', async () => {
  const before = db.getDb()!.prepare('SELECT id, moods, energy, source FROM tracks ORDER BY id').all();
  const lines = await capture(() => propagationSelfCheck(() => { throw new Error('knn down'); }, 0.35, { yieldBetweenVotes: true }));
  assert.ok(lines.some((l) => l.includes('propagation self-check failed: knn down')), lines.join('\n'));
  assert.deepEqual(db.getDb()!.prepare('SELECT id, moods, energy, source FROM tracks ORDER BY id').all(), before);
});
