// M1, the link path: a link is written for the moment its track starts, and
// its stated time is judged against THAT clock. Links were 171 of the 231 wrong
// times measured on air (9 Sep–16 Oct). The only mocked component is the
// OpenAI-compatible HTTP boundary; generateLink, prompt composition and the
// clock check all run.
// Run: npm test -- clock-phrases-link

import assert from 'node:assert/strict';
import { chatCompletionResponse } from './test-utils/llm.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-clock-link-'));

const settings = await import('../src/settings.js');
const { generateLink, fuzzyAirTime } = await import('../src/llm/internal/prompts/scripts.js');

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
});

let reply = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => chatCompletionResponse({
  id: 'chatcmpl-fixture',
  message: { role: 'assistant', content: reply },
  usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
})) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const HOST = { name: 'Somer', soul: 'warm', language: '', linkStyle: 'natural', scriptLength: 'concise' };
const current = { title: 'Take A Second', artist: 'Bar.ba' };
// The air-time clock the link is written for: 11:48, as on 12 Oct.
const clock = { hhmm: '11:48', display: '11:48' };

test('the 12 Oct link: "just past ten" written for 11:48 airs as "approaching noon"', async () => {
  reply = 'The Free Electron rolls through Plakias just past ten on a Monday, and right now we\'re letting Take A Second breathe.';
  const link = await generateLink({ previous: null, current, context: { clock }, clockIsAirTime: true, persona: HOST });
  assert.equal(fuzzyAirTime(clock), 'approaching noon');
  assert.equal(link, 'The Free Electron rolls through Plakias approaching noon on a Monday, and right now we\'re letting Take A Second breathe.');
});

test('a link stating the time it airs at is untouched', async () => {
  reply = 'Approaching noon on a Monday, and here is Take A Second.';
  const link = await generateLink({ previous: null, current, context: { clock }, clockIsAirTime: true, persona: HOST });
  assert.equal(link, reply);
});

test('without a verified air time, a stated time drops its sentence', async () => {
  // The prompt already says "Do not state a clock time" here; this is the
  // check that the line obeys it.
  reply = 'Just after ten on a proper Monday. Here is Take A Second by Bar.ba.';
  const link = await generateLink({ previous: null, current, context: { clock }, clockIsAirTime: false, persona: HOST });
  assert.equal(link, 'Here is Take A Second by Bar.ba.');
});

test('a non-English persona\'s link passes unchanged', async () => {
  reply = 'Just past ten in Plakias, kalimera.';
  const link = await generateLink({
    previous: null, current, context: { clock }, clockIsAirTime: true,
    persona: { ...HOST, language: 'Greek' },
  });
  assert.equal(link, reply);
});
