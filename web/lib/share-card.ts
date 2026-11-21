// The share card's colours, from the station logo's pixels: pure, so it
// is tested without an image decoder. `app/og/route.js` decodes the logo to a
// small RGBA grid and asks this for the card's background and text colours.
//
// The background is taken from the logo itself:
// - a logo with an opaque edge (a square tile, a badge on a coloured field)
//   puts its edge colour behind it, so the logo blends into the card and reads
//   as one picture;
// - a logo cut out on transparency gets its own dominant colour, darkened, so
//   the shape stands out against a field of its own hue.
// `text`/`muted` are near-white or near-black, whichever reads on that
// background (the card draws only the logo today; kept for any caption).

export interface Rgb { r: number; g: number; b: number }

export interface CardColours {
  background: string; // #rrggbb
  text: string;
  muted: string;
}

const OPAQUE = 200;      // alpha at or above which a pixel counts as solid
const EDGE_SOLID = 0.6;  // share of solid edge pixels for "opaque edge"
const BIN = 32;          // per-channel bin width when finding the commonest colour

const hex = (c: Rgb) => `#${[c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// Relative luminance (sRGB, WCAG).
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The mean colour of the commonest coarse bin among `pixels` (RGB triples).
function commonest(pixels: Rgb[]): Rgb | null {
  if (!pixels.length) return null;
  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (const p of pixels) {
    const key = `${Math.floor(p.r / BIN)},${Math.floor(p.g / BIN)},${Math.floor(p.b / BIN)}`;
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += p.r; bin.g += p.g; bin.b += p.b;
    bins.set(key, bin);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  return best && { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
}

// Scale a colour down until its luminance is at most `target`.
function darken(c: Rgb, target: number): Rgb {
  let k = 1;
  let out = c;
  while (luminance(out) > target && k > 0.05) {
    k *= 0.9;
    out = { r: c.r * k, g: c.g * k, b: c.b * k };
  }
  return out;
}

// `rgba` is width*height*4 bytes, row-major (sharp's raw output).
export function cardColours(rgba: Uint8Array, width: number, height: number): CardColours {
  const at = (x: number, y: number): [Rgb, number] => {
    const i = (y * width + x) * 4;
    return [{ r: rgba[i] ?? 0, g: rgba[i + 1] ?? 0, b: rgba[i + 2] ?? 0 }, rgba[i + 3] ?? 0];
  };
  const edge: Rgb[] = [];
  let edgeCount = 0;
  const solid: Rgb[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [c, a] = at(x, y);
      const onEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (onEdge) edgeCount++;
      if (a < OPAQUE) continue;
      solid.push(c);
      if (onEdge) edge.push(c);
    }
  }
  let bg: Rgb;
  if (edgeCount && edge.length / edgeCount >= EDGE_SOLID) {
    bg = commonest(edge)!;
  } else {
    const dominant = commonest(solid) ?? { r: 16, g: 14, b: 12 };
    bg = darken(dominant, 0.06);
  }
  const light = luminance(bg) > 0.35;
  return {
    background: hex(bg),
    text: light ? '#141210' : '#f4f1ec',
    muted: light ? 'rgba(20,18,16,0.62)' : 'rgba(244,241,236,0.66)',
  };
}
