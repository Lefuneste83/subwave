// djText — free-text DJ generation (intros, links, idents, skill segments).
//
// Runs inside withFailover (primary→fallback on host-unreachable) with a
// transient-retry on the active leg. Resolves its model + sampling per leg, so a
// primary→fallback switch across different providers picks the right path.

import { generateText } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, truncationError, usageOf, perfOf, warningsOf, failureDiagnostics } from '../core/pure.js';
import { llmCallOptions, repeatPenaltyApplies, samplingWithLocalKnobs } from '../provider/capabilities.js';
import { personaLanguages, resolveMaxOutputTokens } from '../../../settings.js';
import { scriptLeakVerdict, type ScriptLeak } from '../../../util/script-leak-policy.js';
import { logEvent } from '../../../observability/events.js';

// Hard output-token cap. A reasoning model with no cap can generate until it
// fills the whole context window — one runaway <think> ramble then ties up the
// inference slot for minutes. Generous backstop for normal output (idents are
// ~150 tokens); raise it if you turn `llm.reasoning` on and need room for the
// chain-of-thought. The operator can override via settings.llm.maxOutputTokens
// (issue #712); 0 there keeps this default.
const MAX_TOKENS_TEXT = 4000;

// `speaker` is the persona the line will be spoken by. When a caller names it,
// the reply is checked for a word from a writing system the speaker's language
// does not use (util/script-leak-policy.ts), judged against everything the
// model was handed (system + prompt carry the names it may write), and a leak
// is regenerated ONCE, with a note naming the stray letters. The homelab
// default is slow, so never more than once. Look-alike letters alone (a
// Cyrillic а inside a Greek word) are folded into the word's script and the
// mended line comes back with no retry (the policy's `fold`). The retry's own answer is returned
// whatever it holds: queue.speakable is the gate that drops a line still
// leaking, so a dropped line is never recorded as said. Without `speaker` the
// call is unchanged.
export async function djText(args: any): Promise<string> {
  const out = await djTextOnce(args);
  if (args?.speaker === undefined) return out;
  const languages = personaLanguages(args.speaker);
  const verdict = scriptLeakVerdict(out, { languages, names: [args.system, args.prompt], surface: 'speech', retry: true });
  // Look-alike letters, or a space missing before a name, are mended in
  // place: the line is right once they are, so it costs no second call.
  if (verdict.action === 'fold') {
    logEvent('speech.scriptLeak', { kind: args.kind || 'sdk.djText', stage: 'writer', outcome: 'folded', language: languages.primary, folded: verdict.folds.map((f) => `${f.from}→${f.to}`) });
    return verdict.text;
  }
  if (verdict.action !== 'regenerate') return out;
  const { leak } = verdict;
  const kind = args.kind || 'sdk.djText';
  logEvent('speech.scriptLeak', { kind, stage: 'retry', language: languages.primary, runs: leak.runs, scripts: leak.scripts });
  try {
    return await djTextOnce({
      ...args,
      prompt: `${args.prompt}${scriptLeakRetryNote(languages.primary, leak)}`,
      seed: typeof args.seed === 'number' ? (args.seed + 1) % 2147483647 : args.seed,
    });
  } catch {
    // The first answer goes on to the gate, which drops it.
    return out;
  }
}

function scriptLeakRetryNote(language: string, leak: ScriptLeak): string {
  return `\n\nWRITING SYSTEM: a draft of this line slipped letters from another writing system into it (${leak.runs.map((r) => `"${r}"`).join(', ')}). Write the line again in ${language}, in its own script, with no word from any other writing system. Names keep exactly the spelling given above.`;
}

async function djTextOnce({
  system,
  prompt,
  temperature = 0.9,
  topP = 0.95,
  repeatPenalty = 1.15,
  seed = null,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_TEXT),
  kind = 'sdk.djText',
  // Caller budgets/cancellation take precedence over the provider deadline.
  signal = undefined,
}: any): Promise<string> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err) }),
    async (leg) => {
      const result = await withTransientRetry(kind, () => generateText({
        model: leg.model,
        instructions: system,
        prompt,
        temperature,
        topP,
        ...(seed != null ? { seed } : {}),
        maxOutputTokens,
        ...llmCallOptions(leg.cfg),
        ...(signal ? { abortSignal: signal } : {}),
      }), signal);
      // A free-text DJ script that hit the output-token cap is never a usable
      // reply — real scripts run ~150 tokens against the 4000-token backstop,
      // so 'length' means a reasoning model ran away mid-thought (issue #947:
      // it tied up the TTS GPU for minutes). Fail the call instead —
      // announce-path callers catch and skip the segment, so the station
      // stays on air, just without this talk break.
      const truncated = truncationError(result);
      if (truncated) throw truncated;
      const out = stripThinking(result.text);
      // Only record sampling knobs that actually reached the model — see
      // repeatPenaltyApplies() (currently false everywhere: ai-sdk-ollama v4
      // lost the per-call channel) and samplingWithLocalKnobs() for the
      // body-injection providers.
      const sampling: any = { temperature, top_p: topP, seed };
      if (repeatPenaltyApplies(leg.cfg)) sampling.repeat_penalty = repeatPenalty;
      samplingWithLocalKnobs(leg.cfg, sampling);
      return {
        value: out,
        via: 'ai-sdk',
        sampling,
        usage: usageOf(result),
        perf: perfOf(result),
        warnings: warningsOf(result),
        // Full, untruncated — the /debug surface shows the whole system prompt.
        extra: { system, user: prompt, response: out },
      };
    },
    undefined,
    signal,
  );
}
