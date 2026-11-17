// Where the incoming track's beat is HEARD against the outgoing one's (DJ Hot
// Mix seams, music/hot-mix-seam.ts). A stored grid places each beat where the
// beat tracker put it, and the ear does not lock to that point, nor to the
// kick's attack: in blind listening tests on on-air seams it locked to the
// on-beat percussion (hats, claps), which sits a track-specific distance from
// the grid (here 0 to ~25 ms before or after it). So two grids aligned beat
// for beat sound right for some pairs and 15-20 ms off for others. Measured
// per side and differenced, this agreed with the operator's ear on 13 of 15
// seams; a kick-attack correction (tried first, removed) disagreed on 5 of 8,
// once by 27 ms on air (music.md, the seam).
//
// The measure: the audio above 2 kHz, its envelope's rises, folded over the
// side's own grid beats within FOLD_SEC either way (every beat weighs the
// same, whatever the fade does to its level). The fold's peak is where that
// side's percussion lands after its grid beat. It is trusted only when the
// peak is clear (PEAK_MIN_SHARE: enough of the beats agree on it) and on the beat
// (within ON_BEAT_SEC): a side whose percussion sits off the beat (offbeat
// hats only, no hats at all) has no on-beat point to align, and the seam
// stays grid on grid. The correction is capped (SHIFT_MAX_SEC).
//
// The decode is sequential with `-ss` as an OUTPUT option: an input seek on a
// VBR MP3 over HTTP is an estimate, and the mixer plays the track from its
// first sample, so this reads the same timeline. Never throws.
import { spawn } from 'node:child_process';

export const PHASE_SR = 22050;
export const FOLD_SEC = 0.12;
export const ON_BEAT_SEC = 0.06;
// Fitted on the 15 seams the operator judged blind (17 Nov): real music puts
// the fold's peak at 0.3-0.9 of the beats. At 0.35 the correction agrees with
// the ear on 13 of 15; at 0.5 it left four seams heard offbeat on their grids.
export const PEAK_MIN_SHARE = 0.35;
export const SHIFT_MAX_SEC = 0.03;
export const MIN_BEATS = 8;
const SMOOTH_SEC = 0.002;

export interface BeatOffset {
  offsetSec: number; // where the percussion lands after the grid beat (negative: before)
  share: number;     // the fold's peak height, 0-1: how many beats agree on it
  beats: number;
}

// The percussion's offset against the grid beats, from `pcm` (mono, high-passed,
// `sr`, sample 0 at `fromSec`). Null with too few whole beats or a silent signal.
export function beatOffset(pcm: Int16Array | Float64Array, sr: number, fromSec: number, beats: readonly number[]): BeatOffset | null {
  const n = pcm.length;
  if (n < 16 || beats.length < MIN_BEATS) return null;
  const k = Math.max(1, Math.round(SMOOTH_SEC * sr));
  // |x| smoothed over k samples, then its rises.
  const env = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += Math.abs(pcm[i]);
    if (i >= k) run -= Math.abs(pcm[i - k]);
    env[i] = run / k;
  }
  const rise = new Float64Array(n);
  for (let i = 1; i < n; i++) rise[i] = Math.max(0, env[i] - env[i - 1]);
  const W = Math.round(FOLD_SEC * sr);
  const acc = new Float64Array(2 * W);
  let used = 0;
  for (const b of beats) {
    const c = Math.round((b - fromSec) * sr);
    if (c - W < 0 || c + W > n) continue;
    let max = 0;
    for (let j = 0; j < 2 * W; j++) if (rise[c - W + j] > max) max = rise[c - W + j];
    if (!(max > 0)) continue;
    for (let j = 0; j < 2 * W; j++) acc[j] += rise[c - W + j] / max;
    used++;
  }
  if (used < MIN_BEATS) return null;
  let best = 0;
  for (let j = 1; j < 2 * W; j++) if (acc[j] > acc[best]) best = j;
  return { offsetSec: (best - W) / sr, share: Math.round((acc[best] / used) * 100) / 100, beats: used };
}

export type PhaseVerdict =
  | { ok: true; lateSec: number; cueShiftSec: number }
  | { ok: false; reason: string };

// How far B's on-beat percussion lands after A's in OUTPUT seconds through the
// overlap (`lateSec`), and the move of B's cue-in, in B's FILE seconds, that
// cancels it (`cueShiftSec`, positive: start later in the file, so B plays
// earlier). `r` is B's tempo factor through the overlap (liq_mix_tempo: output
// seconds = file seconds / r); `q` is A's (1 unless A ramps on a split seam).
export function percussionPhase(a: BeatOffset | null, b: BeatOffset | null, r: number, q = 1): PhaseVerdict {
  for (const [side, o] of [['outgoing', a], ['incoming', b]] as const) {
    if (!o) return { ok: false, reason: `no ${side} beats to measure` };
    if (o.share < PEAK_MIN_SHARE) return { ok: false, reason: `no clear on-beat percussion in the ${side} track` };
    if (Math.abs(o.offsetSec) > ON_BEAT_SEC) return { ok: false, reason: `the ${side} track's percussion is off the beat` };
  }
  const late = b!.offsetSec / r - a!.offsetSec / q;
  if (Math.abs(late) > SHIFT_MAX_SEC) return { ok: false, reason: `${Math.round(late * 1000)} ms apart, past the ${SHIFT_MAX_SEC * 1000} ms cap` };
  return { ok: true, lateSec: Math.round(late * 1e6) / 1e6, cueShiftSec: Math.round(late * r * 1e6) / 1e6 };
}

// Decode [fromSec, toSec] of `source` (a file or an http URL) as mono s16 at
// PHASE_SR, above 2 kHz. Null on any failure, `reason` saying which, with any
// credential in a URL redacted.
export function decodeHighBand(source: string, fromSec: number, toSec: number, timeoutMs: number):
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
        '-ac', '1', '-ar', String(PHASE_SR), '-af', 'highpass=f=2000,highpass=f=2000',
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

// One side's percussion offset over `beats` (file seconds, ascending). Never throws.
export async function measureBeatOffset(source: string, beats: readonly number[], { timeoutMs = 8000 } = {}):
  Promise<{ offset: BeatOffset | null; reason: string }> {
  if (!source || beats.length < MIN_BEATS) return { offset: null, reason: 'no beats to measure' };
  const from = Math.max(0, beats[0] - 2 * FOLD_SEC);
  const to = beats[beats.length - 1] + 2 * FOLD_SEC;
  const { pcm, reason } = await decodeHighBand(source, from, to, timeoutMs);
  if (!pcm) return { offset: null, reason };
  const offset = beatOffset(pcm, PHASE_SR, from, beats);
  return { offset, reason: offset ? 'ok' : 'too few whole beats decoded' };
}
