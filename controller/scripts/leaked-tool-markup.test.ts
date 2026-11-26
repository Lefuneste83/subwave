// A model's structured answer can carry the server's tool-call markup inside a
// string field: a forced custom-skill segment came back with
// `text: "…Πάμε με τον \"Sundowner\".</text>\n<parameter name=\"sfx\">null"`,
// the display pass stripped the tags, and the DJ read the sibling field's
// `null` out on air. modelTolerant (pure.ts coerceModelPayload) is the repair
// every structured parse goes through, so the cut is pinned there, and on the
// real skill schemas.
//
// Run: npm test -- leaked-tool-markup

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { cutLeakedToolMarkup, modelTolerant } from '../src/llm/internal/core/pure.js';
import { forcedSchema, simpleSegmentSchema } from '../src/skills/_agent.js';

const AIRED = 'Οπότε σταματάω τη φιλοσοφία. Πάμε με τον "Sundowner".';

test('a leaked tool-call boundary ends the string, dangling close tag included', () => {
  assert.equal(cutLeakedToolMarkup(`${AIRED}</text>\n<parameter name="sfx">null`), AIRED);
  assert.equal(cutLeakedToolMarkup(`${AIRED}\n</parameter>\n<parameter=sfx>\nnull\n</parameter>\n</function>`), AIRED);
  assert.equal(cutLeakedToolMarkup(`${AIRED}<tool_call>{"name":"emit"}`), AIRED);
  assert.equal(cutLeakedToolMarkup(`${AIRED}</function>`), AIRED);
});

test('a string with no tool-call tag is returned as is', () => {
  for (const line of [
    AIRED, 'That was <b>loud</b>, and I <3 it.', 'The function of a bassline is the floor.',
    'A parameter in the mix: <reverb>.', '', 'null',
  ]) assert.equal(cutLeakedToolMarkup(line), line, JSON.stringify(line));
});

test('a value that opens with the markup is left for validation, never emptied', () => {
  const v = '<parameter=text>Hello there';
  assert.equal(cutLeakedToolMarkup(v), v);
});

test('the skill schemas parse the aired payload into the clean line', () => {
  const forced = forcedSchema().parse({ text: `${AIRED}</text>\n<parameter name="sfx">null`, sfx: '' });
  assert.equal(forced.text, AIRED);
  const simple = simpleSegmentSchema().parse({ reason: 'r', air: true, text: `${AIRED}</text>\n<parameter name="sfx">null`, sfx: null });
  assert.equal(simple.text, AIRED);
});

test('nested and listed strings are cut too (an exchange\'s lines)', () => {
  const schema = modelTolerant(z.object({
    lines: z.array(z.object({ speaker: z.string(), text: z.string() })),
    segment: z.object({ text: z.string(), sfx: z.string().nullable() }),
  }));
  const out = schema.parse({
    lines: [{ speaker: 'a', text: `${AIRED}</text>\n<parameter name="next">x` }, { speaker: 'b', text: 'Fine.' }],
    segment: { text: `${AIRED}</parameter>`, sfx: 'null' },
  });
  assert.equal(out.lines[0].text, AIRED);
  assert.equal(out.lines[1].text, 'Fine.');
  assert.equal(out.segment.text, AIRED);
  assert.equal(out.segment.sfx, null, 'the existing "null" repair still runs');
});

test('a clean payload keeps its exact values', () => {
  const schema = modelTolerant(z.object({ text: z.string(), sfx: z.string().nullable(), tags: z.array(z.string()) }));
  const raw = { text: AIRED, sfx: 'rain', tags: ['a <b>', 'c'] };
  assert.deepEqual(schema.parse(raw), raw);
});
