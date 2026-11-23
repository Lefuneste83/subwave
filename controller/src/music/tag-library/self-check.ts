// The propagation self-check: re-run the vote on a sample of directly-decided
// tracks (KNN excludes self) and score it against the stored truth. A
// relative signal for judging knob changes run-over-run, not a benchmark
// (propagation-eval.ts). It writes nothing. See tag-library.ts for when it
// runs alongside the acoustic analysis.

import * as db from '../library-db.js';
import type { vote } from '../tag-propagator.js';
import { summariseEval, formatEvalSummary } from '../propagation-eval.js';
import { logEvent } from './log.js';

type Vote = ReturnType<typeof vote>;

export const SELF_CHECK_SAMPLE = 150;

// The sample and its stored truth are read when this is called; the votes
// follow track by track. With `yieldBetweenVotes` the event loop is handed
// back between votes (each is two brute-force KNN scans, about a quarter
// second at 75k tracks), so the analysis it runs beside keeps its requests
// moving. Never throws.
export async function propagationSelfCheck(
  voteForTrack: (id: string) => Vote,
  confidenceThreshold: number,
  { yieldBetweenVotes }: { yieldBetweenVotes: boolean },
): Promise<void> {
  try {
    const truth = db.trustedTaggedIds();
    if (truth.length < 20) return;
    // Partial Fisher-Yates — shuffle just the head we sample.
    const pool = [...truth];
    const n = Math.min(SELF_CHECK_SAMPLE, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const sample = pool.slice(0, n).map((id) => {
      const t = db.getTrack(id)!;
      return { id, actual: { moods: t.moods, energy: t.energy } };
    });
    const cases: Parameters<typeof summariseEval>[0] = [];
    for (const c of sample) {
      if (yieldBetweenVotes) await new Promise<void>((r) => setImmediate(r));
      cases.push({ actual: c.actual, result: voteForTrack(c.id) });
    }
    logEvent('info', formatEvalSummary(summariseEval(cases, confidenceThreshold)));
  } catch (err: any) {
    console.log(`[tag] propagation self-check failed: ${err?.message || err}`);
  }
}
