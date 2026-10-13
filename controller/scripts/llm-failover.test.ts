// Exercise real leg selection/settings/telemetry, with generation callbacks
// replacing only the provider boundary. No provider traffic or credentials.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-failover-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { withFailover, resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');
const { withTransientRetry } = await import('../src/llm/internal/core/retry.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
const primaryLabel = 'ollama:qwen3.5:397b';
const backupLabel = 'ollama:llama3.1:8b';
const fallback = { enabled: true, provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434' };

async function configure(backup: Record<string, unknown> = fallback) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'ollama', model: 'qwen3.5:397b', baseUrl: 'http://127.0.0.1:11434', fallback: backup,
  } }));
  store.setCache(null);
  await settings.load();
  recentCalls.length = 0;
}

function retired() {
  return Object.assign(new Error('model qwen3.5 has been retired'), {
    statusCode: 503, data: { error: { code: 'model_terminated' } }, __via: 'test-primary',
  });
}

const failExtra = (err: Error) => ({ diagnostic: err.message });

after(() => {
  recentCalls.length = 0;
});

test('a permanent primary failure returns the backup result without controller retries and records both legs', async () => {
  await configure();
  const error = retired();
  // Permanent reason must win even when the provider also says overloaded.
  error.message += ' (upstream overloaded, retry later)';
  const attempts: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const result = await withFailover('retirement-test', failExtra, (leg) => withTransientRetry('retirement-test', async () => {
      attempts.push(leg.label);
      if (leg.label === primaryLabel) throw error;
      return { value: 'backup speech', via: 'test-backup', usage: { input: 2, output: 3, total: 5 }, extra: { response: 'backup speech' } };
    }));
    assert.equal(result, 'backup speech');
    assert.deepEqual(attempts, [primaryLabel, backupLabel]);
    assert.ok(logs.some((line) => line.includes('model unavailable (503) — failing over')));
    assert.ok(!logs.some((line) => line.includes('retrying in')));
    assert.equal(recentCalls.length, 2);
    const [success, failure] = recentCalls;
    assert.equal(failure.ok, false);
    assert.equal(failure.model, primaryLabel);
    assert.equal(failure.via, `test-primary:failover→${backupLabel}`);
    assert.equal(failure.error, error.message);
    assert.equal(failure.diagnostic, error.message);
    assert.equal(success.ok, true);
    assert.equal(success.model, backupLabel);
    assert.equal(success.via, 'test-backup');
    assert.equal(success.response, 'backup speech');
    assert.deepEqual(success.usage, { input: 2, output: 3, total: 5 });
  } finally {
    console.log = originalLog;
  }
});

for (const [name, backup] of [
  ['disabled', { ...fallback, enabled: false }],
  ['unusable', { enabled: true, provider: 'openai-compatible', model: 'missing', baseUrl: '' }],
] as const) {
  test(`${name} fallback preserves the original primary error`, async () => {
    await configure(backup);
    const error = retired();
    const attempts: string[] = [];
    await assert.rejects(withFailover('no-backup-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      throw error;
    }), (err) => err === error);
    assert.deepEqual(attempts, [primaryLabel]);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].via, 'test-primary');
    assert.equal(recentCalls[0].model, primaryLabel);
    assert.equal(recentCalls[0].ok, false);
  });
}

for (const pin of ['primary', 'fallback'] as const) {
  test(`pinned ${pin} never switches legs on a permanent model failure`, async () => {
    await configure();
    const error = retired();
    const attempts: string[] = [];
    const label = pin === 'primary' ? primaryLabel : backupLabel;
    await assert.rejects(withFailover('pinned-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      throw error;
    }, pin), (err) => err === error);
    assert.deepEqual(attempts, [label]);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].model, label);
    assert.equal(recentCalls[0].via, 'test-primary:pinned');
  });
}

test('a failed backup propagates its own error and does not return to the primary', async () => {
  await configure();
  const primaryError = retired();
  const backupError = Object.assign(new Error('model llama3.1:8b not found'), { __via: 'test-backup' });
  const attempts: string[] = [];
  await assert.rejects(withFailover('failed-backup-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    throw leg.label === primaryLabel ? primaryError : backupError;
  }), (err) => err === backupError);
  assert.deepEqual(attempts, [primaryLabel, backupLabel]);
  assert.equal(recentCalls.length, 2);
  assert.deepEqual(recentCalls.map((call) => [call.model, call.ok, call.error]), [
    [backupLabel, false, backupError.message], [primaryLabel, false, primaryError.message],
  ]);
  assert.equal(recentCalls[0].via, 'test-backup');
});

test('an unrelated removed endpoint does not select an otherwise healthy backup', async () => {
  await configure();
  const error = new Error('The requested API endpoint has been removed');
  const attempts: string[] = [];
  await assert.rejects(withFailover('endpoint-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    if (leg.label === primaryLabel) throw error;
    return { value: 'must not use backup', via: 'test-backup' };
  }), (err) => err === error);
  assert.deepEqual(attempts, [primaryLabel]);
  assert.equal(recentCalls.length, 1);
  assert.equal(recentCalls[0].model, primaryLabel);
});

// ── D5: a 5xx that survived same-leg retries fails over, and a down primary is remembered ──

const bare500 = () => Object.assign(new Error('Internal Server Error'), { statusCode: 500, __via: 'test-primary' });
const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED', __via: 'test-primary' });

after(() => resetFailoverStickyForTest());

test('a bare 500 with no wording fails over to the backup (the locca model-off case)', async () => {
  resetFailoverStickyForTest();
  await configure();
  const error = bare500();
  const attempts: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const result = await withFailover('exhausted-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      if (leg.label === primaryLabel) throw error;
      return { value: 'backup speech', via: 'test-backup' };
    });
    assert.equal(result, 'backup speech');
    assert.deepEqual(attempts, [primaryLabel, backupLabel]);
    assert.ok(logs.some((line) => line.includes('cannot serve (5xx after retries) (500) — failing over')));
    // The primary is marked down: the very next call must not re-try it.
    const second: string[] = [];
    await withFailover('exhausted-test', failExtra, async (leg) => {
      second.push(leg.label);
      return { value: 'still backup', via: 'test-backup' };
    });
    assert.deepEqual(second, [backupLabel]);
  } finally {
    console.log = originalLog;
    resetFailoverStickyForTest();
  }
});

test('a refused host fails over at once and the sticky window routes the next call straight to the backup', async () => {
  resetFailoverStickyForTest();
  await configure();
  const error = refused();
  const attempts: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const result = await withFailover('refused-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      if (leg.label === primaryLabel) throw error;
      return { value: 'backup speech', via: 'test-backup' };
    });
    assert.equal(result, 'backup speech');
    assert.deepEqual(attempts, [primaryLabel, backupLabel]);
    assert.ok(logs.some((line) => line.includes('unreachable (ECONNREFUSED) — failing over')));
    const second: string[] = [];
    await withFailover('refused-test', failExtra, async (leg) => {
      second.push(leg.label);
      return { value: 'still backup', via: 'test-backup' };
    });
    assert.deepEqual(second, [backupLabel]);
    assert.ok(logs.some((line) => line.includes('marked down — using')));
  } finally {
    console.log = originalLog;
    resetFailoverStickyForTest();
  }
});

test('a sticky window with no configured backup still lets the primary be tried', async () => {
  resetFailoverStickyForTest();
  await configure({ ...fallback, enabled: false });
  const error = refused();
  const attempts: string[] = [];
  for (let i = 0; i < 2; i++) {
    await assert.rejects(withFailover('no-backup-sticky-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      throw error;
    }), (err) => err === error);
  }
  assert.deepEqual(attempts, [primaryLabel, primaryLabel], 'nowhere to route — the primary keeps getting its try');
  resetFailoverStickyForTest();
});

test('the sticky window expires and the primary is tried again', async () => {
  resetFailoverStickyForTest(50); // 50 ms window for this test
  await configure();
  const error = refused();
  let primaryAttempts = 0;
  const result = await withFailover('expiry-test', failExtra, async (leg) => {
    if (leg.label === primaryLabel) { primaryAttempts++; throw error; }
    return { value: 'backup speech', via: 'test-backup' };
  });
  assert.equal(result, 'backup speech');
  await new Promise((r) => setTimeout(r, 80));
  const second = await withFailover('expiry-test', failExtra, async (leg) => {
    if (leg.label === primaryLabel) { primaryAttempts++; throw error; }
    return { value: 'backup again', via: 'test-backup' };
  });
  assert.equal(second, 'backup again');
  assert.equal(primaryAttempts, 2, 'after expiry the primary is re-tried and fails over again');
  resetFailoverStickyForTest(); // restore the production default
});

test('pinned calls ignore the sticky window (an explicit leg choice)', async () => {
  resetFailoverStickyForTest();
  await configure();
  const error = refused();
  // Establish the sticky state through a normal failover…
  await withFailover('pin-sticky-test', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw error;
    return { value: 'backup', via: 'test-backup' };
  });
  // …then a pinned-primary call must still hit the primary.
  const attempts: string[] = [];
  await assert.rejects(withFailover('pin-sticky-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    throw error;
  }, 'primary'), (err) => err === error);
  assert.deepEqual(attempts, [primaryLabel]);
  resetFailoverStickyForTest();
});

test('a refused host skips same-leg retries so failover decides at once', async () => {
  await configure();
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  let calls = 0;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await assert.rejects(withTransientRetry('refused-retry-test', async () => { calls++; throw error; }), (err) => err === error);
    assert.equal(calls, 1, 'no backoff against a dead port');
    assert.ok(!logs.some((line) => line.includes('retrying in')));
  } finally {
    console.log = originalLog;
  }
});

test('a temporary failure (EAI_AGAIN) still gets its same-leg retries', async () => {
  await configure();
  const error = Object.assign(new Error('getaddrinfo EAI_AGAIN locca'), { code: 'EAI_AGAIN' });
  let calls = 0;
  await assert.rejects(withTransientRetry('again-retry-test', async () => { calls++; throw error; }), (err) => err === error);
  assert.equal(calls, 3, 'EAI_AGAIN can clear in a second — the retries are worth it');
});


// ── D5 review: what may and may not start the sticky window ──

const { ProviderRequestTimeoutError } = await import('../src/llm/internal/core/generation.js');
const { generateText } = await import('ai');
const http = await import('node:http');

function agentDeadline() {
  const err = new Error('djAgentPick main run — deadline 45000ms exceeded');
  err.name = 'AgentDeadlineError';
  return err;
}

test('a 400 whose message mentions 500 is a bad request: no failover, primary not marked down', async () => {
  resetFailoverStickyForTest();
  await configure();
  const error = Object.assign(new Error('max_tokens must be at most 500'), { statusCode: 400, __via: 'test-primary' });
  const attempts: string[] = [];
  await assert.rejects(withFailover('bad-request-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    throw error;
  }), (err) => err === error);
  await withFailover('bad-request-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'primary fine', via: 'test-primary' };
  });
  assert.deepEqual(attempts, [primaryLabel, primaryLabel], 'the next call still goes to the primary');
  resetFailoverStickyForTest();
});

test('switching the primary in settings clears a sticky window set for the old one', async () => {
  resetFailoverStickyForTest();
  await configure();
  await withFailover('switch-test', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw bare500();
    return { value: 'backup', via: 'test-backup' };
  });
  // The operator moves the primary to another model.
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'ollama', model: 'mistral3:14b', baseUrl: 'http://127.0.0.1:11434', fallback,
  } }));
  store.setCache(null);
  await settings.load();
  const attempts: string[] = [];
  await withFailover('switch-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'new primary', via: 'test-primary' };
  });
  assert.deepEqual(attempts, ['ollama:mistral3:14b'], 'the new primary is tried at once');
  resetFailoverStickyForTest();
});

test('a provider request timeout fails over and marks the primary down (a model that never answers)', async () => {
  resetFailoverStickyForTest();
  await configure();
  const attempts: string[] = [];
  const result = await withFailover('timeout-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    if (leg.label === primaryLabel) {
      throw new ProviderRequestTimeoutError('req-1', { kind: 'timeout-test', leg: 'primary', provider: 'ollama', modelLabel: primaryLabel, targetId: 't', timeoutMs: 300_000 });
    }
    return { value: 'backup', via: 'test-backup' };
  });
  assert.equal(result, 'backup');
  await withFailover('timeout-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'backup again', via: 'test-backup' };
  });
  assert.deepEqual(attempts, [primaryLabel, backupLabel, backupLabel], 'the next call does not wait out the timeout again');
  resetFailoverStickyForTest();
});

test('an agent deadline with no model answer is not resubmitted, but marks the primary down for the next call', async () => {
  resetFailoverStickyForTest();
  await configure();
  const attempts: string[] = [];
  const deadline = agentDeadline();
  await assert.rejects(withFailover('deadline-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    throw deadline;
  }), (err) => err === deadline);
  assert.deepEqual(attempts, [primaryLabel], 'the spent call itself is not failed over (its budget is gone)');
  await withFailover('deadline-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'backup', via: 'test-backup' };
  });
  assert.deepEqual(attempts, [primaryLabel, backupLabel], 'the next call goes straight to the backup');
  resetFailoverStickyForTest();
});

test('an agent deadline after the model DID answer is an overthinking model: primary stays in use', async () => {
  resetFailoverStickyForTest();
  // An OpenAI-compatible stand-in that answers every chat call at once.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 0, model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  try {
    writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
      provider: 'openai-compatible', model: 'stub', baseUrl: `http://127.0.0.1:${port}/v1`, fallback,
    } }));
    store.setCache(null);
    await settings.load();
    const stubLabel = 'openai-compatible:stub';
    const attempts: string[] = [];
    const deadline = agentDeadline();
    await assert.rejects(withFailover('overthink-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      await generateText({ model: leg.model, prompt: 'hello' }); // one real answer
      throw deadline; // …then the agent ran out of budget
    }), (err) => err === deadline);
    await withFailover('overthink-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      return { value: 'primary', via: 'test-primary' };
    });
    assert.deepEqual(attempts, [stubLabel, stubLabel], 'an answering primary is not marked down');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetFailoverStickyForTest();
  }
});
