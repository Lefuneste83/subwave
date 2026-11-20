// The share card's colours, taken from the logo (share-card.ts).
//
// Run: npm test -- share-card

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardColours, luminance, nameFontSize } from './share-card';

// A w×h RGBA grid filled by `fill(x, y)`.
function grid(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(fill(x, y), (y * w + x) * 4);
  return out;
}

test('a logo on an opaque field puts that field behind it', () => {
  // navy tile with an orange disc in the middle
  const px = grid(16, 16, (x, y) => ((x - 8) ** 2 + (y - 8) ** 2 < 20 ? [240, 120, 20, 255] : [12, 30, 80, 255]));
  const c = cardColours(px, 16, 16);
  assert.equal(c.background, '#0c1e50');
  assert.equal(c.text, '#f4f1ec', 'light text on a dark field');
});

test('a light field gets dark text', () => {
  const px = grid(8, 8, () => [245, 240, 230, 255]);
  const c = cardColours(px, 8, 8);
  assert.equal(c.background, '#f5f0e6');
  assert.equal(c.text, '#141210');
});

test('a cut-out logo gets its own colour, darkened behind it', () => {
  // transparent around a bright red shape
  const px = grid(16, 16, (x, y) => (x > 3 && x < 12 && y > 3 && y < 12 ? [230, 40, 40, 255] : [0, 0, 0, 0]));
  const c = cardColours(px, 16, 16);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(c.background.slice(i, i + 2), 16)) as [number, number, number];
  assert.ok(r > g && r > b, `still red: ${c.background}`);
  assert.ok(luminance({ r, g, b }) <= 0.06, `darkened: ${c.background}`);
  assert.equal(c.text, '#f4f1ec');
});

test('a fully transparent image falls back to a dark card', () => {
  const c = cardColours(grid(4, 4, () => [0, 0, 0, 0]), 4, 4);
  assert.equal(c.background, '#100e0c');
});

test('long station names step down in size', () => {
  assert.equal(nameFontSize('Kiss FM'), 88);
  assert.equal(nameFontSize('Southern Star Radio'), 72);
  assert.ok(nameFontSize('The Very Long Name Of A Community Radio Station') < 58);
});
