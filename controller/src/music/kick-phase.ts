// Where the incoming track's kick sits against the outgoing one's (DJ Hot Mix
// seams, music/hot-mix-seam.ts). A stored grid places each beat where the beat
// tracker heard it, and that is a steady few to ~45 ms before the kick's
// attack, by an amount that differs per track (six library tracks, whole
// file: 0, 7, 8, 15, 24 and 43 ms, each steady across the track). Two grids
// aligned beat for beat therefore flam by the difference. A DJ lines up the
// kicks, so the seam does too: the queue measures how far B's kick sits after
// A's over the overlap's own beats and moves B's cue-in by that much.
//
// Picking each beat's attack was too fragile on real kicks (a soft attack, a
// hat riding the low band: one track read -5 ms by it and +7 by a whole-file
// onset measure), so this compares the two kicks directly. Each side's energy
// below 150 Hz is folded over its grid beats into ONE averaged beat
// (TEMPLATE_BINS phases, half a beat either side of each grid beat; every beat
// weighs the same, whatever the fade does to its level), and the two beats are
// cross-correlated, circularly, within TEMPLATE_MAX_SHIFT of a beat. The lag
// is in beats, which is the right unit: through the overlap both sides play
// one beat every pA / q output seconds. Measured on three rendered seams: a
// pair heard 14 ms apart came to 2 ms, another moved from -2 to +7, and a pair
// whose incoming opening has no steady kick (match under TEMPLATE_MIN_CORR)
// was left on its grids.
//
// The decode is sequential with `-ss` as an OUTPUT option: an input seek on a
// VBR MP3 over HTTP is an estimate, and the mixer plays the outgoing track
// from its first sample, so this reads the same timeline. Never throws.
import { spawn } from 'node:child_process';

export const KICK_SR = 11025;
const HOP = 16;
export const TEMPLATE_BINS = 128;
export const TEMPLATE_MIN_CORR = 0.5;
export const TEMPLATE_MIN_BEATS = 8;
const TEMPLATE_MAX_SHIFT = 0.15;

// One averaged beat of `pcm` (mono, `sr`, sample 0 at `fromSec`), centred on
// the grid beats, standardised. Null with too few whole beats or a flat signal.
export function beatTemplate(pcm: Int16Array, sr: number, fromSec: number, beats: readonly number[]): Float64Array | null {
  const hopSec = HOP / sr;
  const frames = Math.floor(pcm.length / HOP);
  if (frames < 8 || beats.length < TEMPLATE_MIN_BEATS + 1) return null;
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) e += pcm[i] * pcm[i];
    env[f] = Math.sqrt(e / HOP);
  }
  const t = new Float64Array(TEMPLATE_BINS);
  let used = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    const p = beats[i + 1] - beats[i];
    if (!(p > 0)) continue;
    let whole = true;
    const row = new Float64Array(TEMPLATE_BINS);
    for (let b = 0; b < TEMPLATE_BINS; b++) {
      const f = (beats[i] + (b / TEMPLATE_BINS - 0.5) * p - fromSec) / hopSec;
      const f0 = Math.floor(f);
      if (f0 < 0 || f0 + 1 >= frames) { whole = false; break; }
      row[b] = env[f0] + (env[f0 + 1] - env[f0]) * (f - f0);
    }
    if (!whole) continue;
    const mean = row.reduce((a, x) => a + x, 0) / TEMPLATE_BINS;
    if (!(mean > 0)) continue;
    for (let b = 0; b < TEMPLATE_BINS; b++) t[b] += row[b] / mean;
    used++;
  }
  if (used < TEMPLATE_MIN_BEATS) return null;
  const m = t.reduce((a, x) => a + x, 0) / TEMPLATE_BINS;
  let sd = 0;
  for (let b = 0; b < TEMPLATE_BINS; b++) { t[b] -= m; sd += t[b] * t[b]; }
  sd = Math.sqrt(sd / TEMPLATE_BINS);
  if (!(sd > 1e-9)) return null;
  for (let b = 0; b < TEMPLATE_BINS; b++) t[b] /= sd;
  return t;
}

// How far B's beat sits after A's, in beats (negative: before), and how alike
// the two are. Null when they are too unlike to align on.
export function relativePhase(a: Float64Array, b: Float64Array): { beats: number; corr: number } | null {
  const n = TEMPLATE_BINS;
  const corrAt = (k: number) => {
    let c = 0;
    for (let i = 0; i < n; i++) c += a[i] * b[(i + k + n) % n];
    return c / n;
  };
  const max = Math.round(TEMPLATE_MAX_SHIFT * n);
  let best = -Infinity;
  let lag = 0;
  for (let k = -max; k <= max; k++) {
    const c = corrAt(k);
    if (c > best) { best = c; lag = k; }
  }
  if (best < TEMPLATE_MIN_CORR) return null;
  // Parabolic refinement around the peak, for sub-bin precision.
  const y0 = corrAt(lag - 1);
  const y2 = corrAt(lag + 1);
  const den = y0 - 2 * best + y2;
  const frac = den !== 0 ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / (2 * den))) : 0;
  return { beats: (lag + frac) / n, corr: Math.round(best * 100) / 100 };
}

// Decode [fromSec, toSec] of `source` (a file or an http URL) as mono s16 at
// KICK_SR, below 150 Hz. Null on any failure, `reason` saying which, with any
// credential in a URL redacted.
export function decodeLowBand(source: string, fromSec: number, toSec: number, timeoutMs: number):
  Promise<{ pcm: Int16Array | null; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (pcm: Int16Array | null, reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ pcm, reason: reason.replace(/([?&](?:t|s|p|u)=)[^&\s]+/g, '$1…') });
    };
    try {
      const proc = spawn('ffmpeg', [
        '-v', 'error', '-nostdin', '-i', source,
        '-ss', Math.max(0, fromSec).toFixed(4), '-t', Math.max(0.1, toSec - fromSec).toFixed(4),
        '-ac', '1', '-ar', String(KICK_SR), '-af', 'lowpass=f=150,lowpass=f=150',
        '-f', 's16le', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d) => { if (err.length < 1000) err += d.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        done(null, `ffmpeg timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      proc.on('error', (e) => { clearTimeout(timer); done(null, `ffmpeg unavailable: ${e.message}`); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null, `ffmpeg exit ${code}: ${err.trim().slice(-200)}`);
        const buf = Buffer.concat(chunks);
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
        done(pcm, 'ok');
      });
    } catch (e) {
      done(null, `ffmpeg failed to start: ${(e as Error)?.message ?? e}`);
    }
  });
}

// One side's averaged beat over `beats` (file seconds, ascending). Never throws.
export async function measureBeatTemplate(source: string, beats: readonly number[], { timeoutMs = 8000 } = {}):
  Promise<{ template: Float64Array | null; reason: string }> {
  if (!source || beats.length < TEMPLATE_MIN_BEATS + 1) return { template: null, reason: 'no beats to measure' };
  const span = beats[1] - beats[0];
  const from = Math.max(0, beats[0] - span);
  const to = beats[beats.length - 1] + span;
  const { pcm, reason } = await decodeLowBand(source, from, to, timeoutMs);
  if (!pcm) return { template: null, reason };
  const template = beatTemplate(pcm, KICK_SR, from, beats);
  return { template, reason: template ? 'ok' : 'too few whole beats decoded' };
}
