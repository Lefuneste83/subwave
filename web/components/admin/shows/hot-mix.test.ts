import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateShow, showFacets, showPayload } from './lib';
import { nextCurvePoint, PHRASE_BAR_OPTIONS } from './HotMixFields';
import { showSchema } from '@/lib/schemas.generated';

// The Hot Mix block from the stored show to the wire and back. A field left out
// of hydrateShow reads as off in the editor; left out of showPayload, a save
// quietly drops the step or the curve. The controller side is pinned by a cold
// load in controller/scripts/hot-mix-pick-paths.test.ts.

const schema = showSchema({ personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null });
const stored = { id: 's_mix', name: 'Future Frequencies', personaId: 'host' };
const OFF = { enabled: false, maxStepPct: 3, curve: [], closeRequests: true, phraseBars: 8, phraseMix: false };
// A stored show as it may sit on disk: partial or malformed, which is what
// hydrateShow exists to repair.
const fromDisk = (hotMix: unknown) => hydrateShow({ ...stored, hotMix } as never);

test('a show from before the switch hydrates and saves as off, with the defaults', () => {
  const show = hydrateShow(stored);
  assert.deepEqual(show.hotMix, OFF);
  assert.deepEqual(showPayload(show).hotMix, OFF);
});

test('the block survives the editor, the payload and the shared schema', () => {
  const hotMix = { enabled: true, maxStepPct: 4, curve: [{ at: 0, bpm: 118 }, { at: 50, bpm: 128 }], closeRequests: false, phraseBars: 16, phraseMix: true };
  const show = hydrateShow({ ...stored, hotMix });
  assert.deepEqual(show.hotMix, hotMix);
  const parsed = schema.parse(showPayload(show));
  assert.deepEqual(parsed.hotMix, hotMix);
  assert.deepEqual(hydrateShow(parsed).hotMix, hotMix);
});

test('switched off, the step and curve are kept for next time', () => {
  const show = fromDisk({ enabled: false, maxStepPct: 3, curve: [{ at: 20, bpm: 122 }] });
  assert.deepEqual(showPayload(show).hotMix, { enabled: false, maxStepPct: 3, curve: [{ at: 20, bpm: 122 }], closeRequests: true, phraseBars: 8, phraseMix: false });
});

test('the phrase length reaches the wire as a number, and the phrase mix rides through untouched', () => {
  // The select hands its value on as text; the payload sends the number.
  const show = fromDisk({ enabled: true, phraseMix: true });
  (show.hotMix as { phraseBars: unknown }).phraseBars = '24';
  const payload = showPayload(show);
  assert.equal(payload.hotMix.phraseBars, 24);
  assert.equal(payload.hotMix.phraseMix, true, 'no control edits it yet, and a save must not drop it');
  assert.equal(schema.parse(payload).hotMix.phraseBars, 24);
  // A stored length off the list reads as 8, as the controller's load does.
  assert.equal(fromDisk({ enabled: true, phraseBars: 12 }).hotMix.phraseBars, 8);
  (show.hotMix as { phraseBars: unknown }).phraseBars = 12;
  assert.equal(schema.safeParse(showPayload(show)).success, false);
});

test('the phrase length options are the schema\'s own', () => {
  assert.deepEqual(PHRASE_BAR_OPTIONS.map(o => o.value), ['8', '16', '24', '32']);
});

test('a malformed stored block reads as off rather than breaking the editor', () => {
  assert.deepEqual(fromDisk('yes').hotMix, OFF);
  assert.deepEqual(fromDisk({ enabled: true, curve: [{ at: 500, bpm: 1 }] }).hotMix.curve, []);
});

test('the payload orders the curve; the schema refuses a point the operator typed out of bounds', () => {
  const show = fromDisk({ enabled: true });
  show.hotMix.curve = [{ at: 80, bpm: 126 }, { at: 10, bpm: 120 }];
  assert.deepEqual(showPayload(show).hotMix.curve, [{ at: 10, bpm: 120 }, { at: 80, bpm: 126 }]);
  show.hotMix.curve = [{ at: 10, bpm: 300 }];
  assert.equal(schema.safeParse(showPayload(show)).success, false);
});

test('a mixed show says so on its card, and only then', () => {
  const facet = showFacets(fromDisk({ enabled: true, curve: [{ at: 0, bpm: 120 }] })).find(f => f.key === 'hot-mix');
  assert.equal(facet?.label, 'hot mix ±3% · curve · no requests');
  assert.ok(!showFacets(hydrateShow(stored)).some(f => f.key === 'hot-mix'));
});

test('a new curve point lands halfway past the last one, at its tempo', () => {
  assert.deepEqual(nextCurvePoint([]), { at: 0, bpm: 124 });
  assert.deepEqual(nextCurvePoint([{ at: 50, bpm: 128 }, { at: 0, bpm: 118 }]), { at: 75, bpm: 128 });
  assert.deepEqual(nextCurvePoint([{ at: 100, bpm: 122 }]), { at: 100, bpm: 122 });
});
