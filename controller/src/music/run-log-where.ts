// Where a run's steps run, for the run log's "Runs on" lines and its banner
// (run-log-format.ts words them): the machine named by the host the operator
// configured, never a credential, path or query string. Reads config and the
// LLM legs, so it sits apart from the pure formatter.

import { config } from '../config.js';
import { DEFAULT_LOCCA_BASE_URL, embeddingBaseUrl, embeddingProviderInfo, resolveEmbeddingCfg, type Leg } from '../llm/provider.js';
import { hostOf } from './run-log-format.js';

// A model id without its `provider:` prefix ("openai-compatible:qwen3" → "qwen3").
export function modelName(label: string): string {
  const i = label.indexOf(':');
  return i >= 0 ? label.slice(i + 1) : label;
}

// "Navidrome at music.local:4533". The music backend is any Subsonic server;
// the station's own config calls it Navidrome, and so does the operator.
export function navidromeWhere(): string {
  const host = hostOf(config.navidrome.url);
  return host ? `Navidrome at ${host}` : 'Navidrome';
}

// The machine behind a provider config: the host of a self-hosted server, or
// the provider's own API.
function providerHost(cfg: { provider?: string; ollamaUrl?: string; baseUrl?: string }, baseUrl: string): string {
  if (cfg.provider === 'ollama') return hostOf(cfg.ollamaUrl || config.ollama.url) ?? 'Ollama';
  return hostOf(baseUrl) ?? `${cfg.provider ?? 'its'} API`;
}

// "LLM qwen3 at llm.local:11434".
export function llmWhere(leg: Pick<Leg, 'cfg' | 'label'>): string {
  const base = leg.cfg?.provider === 'locca' ? (leg.cfg.baseUrl || DEFAULT_LOCCA_BASE_URL) : (leg.cfg?.baseUrl || '');
  return `LLM ${modelName(leg.label)} at ${providerHost(leg.cfg ?? {}, base)}`;
}

// "embeddings bge-m3 at embed.local:8090".
export function embeddingsWhere(): string {
  try {
    const cfg = resolveEmbeddingCfg();
    const info = embeddingProviderInfo();
    return `embeddings ${info.model} at ${providerHost(cfg as never, embeddingBaseUrl(cfg))}`;
  } catch {
    return 'embeddings';
  }
}

// "analyzer at analyzer.local:8080": the sidecar that answered, else the
// first configured one.
export function analyzerWhere(answered: string | null): string {
  const host = hostOf(answered || config.analyzer.urls[0]);
  return host ? `analyzer at ${host}` : 'analyzer';
}

// The configured sidecar's host, for a problem line about it.
export function configuredAnalyzerHost(): string | null {
  return hostOf(config.analyzer.urls[0]);
}

// The analyzer a run plans to use, before any probe: the configured sidecar,
// else the local worker (ANALYZE_PYTHON, every AIO image).
export function plannedAnalyzerWhere(): string {
  if (config.analyzer.urls.length === 0 && config.analyzer.python) return 'the analysis worker inside this controller';
  return analyzerWhere(null);
}

// The analyzer as a run reaches it: the local worker inside this controller
// (ANALYZE_PYTHON, every AIO image), or the sidecar that answered.
export function analysisBackendWhere(backend: string, answered: string | null): string {
  return backend === 'local' ? 'the analysis worker inside this controller' : analyzerWhere(answered);
}

export const LASTFM_WHERE = 'Last.fm API';
export const MUSICBRAINZ_WHERE = 'MusicBrainz API';
export const LOCAL_WHERE = 'this controller';
