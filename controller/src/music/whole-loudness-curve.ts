// The whole-file loudness curve (loudness v2, `loudness_curve_json`): EBU R128
// short-term loudness (K-weighted, 3 s window, stamped at the window's END) out
// of the same ffmpeg decode as the integrated loudness, stored raw so every
// level feature is a computation on it, never a re-decode:
//   whole  the whole track, one point a second;
//   head   from 3 s to 30 s after the music starts, every 0.5 s;
//   tail   from 30 s before the music stops to 5 s after it, every 0.5 s.
// Points are tenths of a dB (ints); silence sits at FLOOR_TENTHS (-100 LUFS).
// The worker builds it (analyze_worker.py loudness_curve_from_frames); this is
// the controller's one parser, for the answer and for the stored column.

export interface LoudnessSeries {
  startMs: number;
  stepMs: number;
  lufs: number[];
}

export interface WholeLoudnessCurve {
  whole: LoudnessSeries;
  head?: LoudnessSeries;
  tail?: LoudnessSeries;
}

export const FLOOR_TENTHS = -1000;
// Six hours at one point a second: far past any track, short of a runaway.
const MAX_POINTS = 21_600;

function parseSeries(v: unknown): LoudnessSeries | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const startMs = o.startMs;
  const stepMs = o.stepMs;
  if (typeof startMs !== 'number' || !Number.isInteger(startMs) || startMs < 0) return null;
  if (typeof stepMs !== 'number' || !Number.isInteger(stepMs) || stepMs <= 0) return null;
  if (!Array.isArray(o.lufs) || o.lufs.length > MAX_POINTS) return null;
  const lufs: number[] = [];
  for (const x of o.lufs) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    lufs.push(Math.max(FLOOR_TENTHS, Math.round(x)));
  }
  return { startMs, stepMs, lufs };
}

/** A curve from the analyzer's answer or the stored JSON; null when malformed. */
export function parseWholeLoudnessCurve(v: unknown): WholeLoudnessCurve | null {
  let o = v;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const whole = parseSeries(r.whole);
  if (!whole) return null;
  const head = r.head == null ? null : parseSeries(r.head);
  const tail = r.tail == null ? null : parseSeries(r.tail);
  if ((r.head != null && !head) || (r.tail != null && !tail)) return null;
  return { whole, ...(head ? { head } : {}), ...(tail ? { tail } : {}) };
}
