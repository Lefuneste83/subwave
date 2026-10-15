// N2: the /debug "routed to backup" line reads failoverRoutingSnapshot(),
// which must say "routed" exactly while D5's sticky window would send the next
// unpinned call to the backup, and nothing otherwise. Real settings, legs and
// failover; only the provider boundary is a callback. No network traffic.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-failover-routing-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { withFailover, resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');
// The public barrel /debug imports from, so the export itself is covered too.
const { failoverRoutingSnapshot } = await import('../src/llm/log.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');

const primaryLabel = 'locca:qwen38-27B';
const fallback = { enabled: true, provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434' };
const failExtra = (err: Error) => ({ diagnostic: err.message });
const bare500 = () => Object.assign(new Error('Internal Server Error'), { statusCode: 500, __via: 'test-primary' });

async function configure(llm: Record<string, unknown>) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm }));
  store.setCache(null);
  await settings.load();
  recentCalls.length = 0;
}

const base = { provider: 'locca', model: 'qwen38-27B', baseUrl: 'http://127.0.0.1:8080' };

// Mark the primary down the way #1923 does in production: a 5xx that survived
// the same-leg retries, so the call fails over and the window opens.
async function primaryFails() {
  const quiet = console.log;
  console.log = () => {};
  try {
    const result = await withFailover('routing-test', failExtra, async (leg) => {
      if (leg.label === primaryLabel) throw bare500();
      return { value: 'backup speech', via: 'test-backup' };
    });
    assert.equal(result, 'backup speech');
  } finally {
    console.log = quiet;
  }
}

after(() => {
  resetFailoverStickyForTest();
  recentCalls.length = 0;
});

test('normal routing reports nothing', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  assert.equal(failoverRoutingSnapshot(), null);
});

test('a primary marked down reports the backup it is routed to, why and until when', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  const before = Date.now();
  await primaryFails();
  const r = failoverRoutingSnapshot();
  assert.ok(r, 'the window is open, so the line must show');
  assert.equal(r.provider, 'ollama');
  assert.equal(r.model, 'ollama:llama3.1:8b');
  assert.equal(r.kind, 'exhausted');
  assert.ok(r.since >= before && r.since <= Date.now());
  assert.equal(r.until - r.since, 5 * 60_000, 'the production window');
});

test('a primary that answers again clears the line', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await primaryFails();
  assert.ok(failoverRoutingSnapshot());
  // The window expires (simulated by reading past it), the next call tries
  // the primary, and it serves: routing is normal again.
  const until = failoverRoutingSnapshot()!.until;
  assert.equal(failoverRoutingSnapshot(until), null, 'past the window the line is gone, call or no call');
  resetFailoverStickyForTest(10);
  await primaryFails();
  await new Promise((r) => setTimeout(r, 30));
  const result = await withFailover('routing-test', failExtra, async () => ({ value: 'primary speech', via: 'test-primary' }));
  assert.equal(result, 'primary speech');
  assert.equal(failoverRoutingSnapshot(), null);
});

test('an expired window reports nothing even before the next call clears it (a quiet station)', async () => {
  resetFailoverStickyForTest(20);
  await configure({ ...base, fallback });
  await primaryFails();
  assert.ok(failoverRoutingSnapshot(), 'inside the window');
  await new Promise((r) => setTimeout(r, 40));
  // No call has arrived since, so the raw state still exists; the read must
  // not trust it.
  assert.equal(failoverRoutingSnapshot(), null);
});

test('switching the primary in Settings ends the line at once', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await primaryFails();
  assert.ok(failoverRoutingSnapshot());
  await configure({ ...base, model: 'mistral3-14b', fallback });
  assert.equal(failoverRoutingSnapshot(), null, 'the new primary gets the next call');
});

test('disabling the backup ends the line: there is nowhere to route', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await primaryFails();
  assert.ok(failoverRoutingSnapshot());
  await configure({ ...base, fallback: { ...fallback, enabled: false } });
  assert.equal(failoverRoutingSnapshot(), null);
});

test('reading the snapshot never changes routing', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await primaryFails();
  for (let i = 0; i < 5; i++) failoverRoutingSnapshot();
  const attempts: string[] = [];
  await withFailover('routing-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'still backup', via: 'test-backup' };
  });
  assert.deepEqual(attempts, ['ollama:llama3.1:8b'], 'the window still holds after repeated reads');
});
