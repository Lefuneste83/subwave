// The Era tab's per-track "Search" (find a recording's release year by hand).
// A web page cannot reach the browser's default search engine, so the operator
// picks one here, remembered in this browser only.

export const SEARCH_ENGINES = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  qwant: { label: 'Qwant', url: 'https://www.qwant.com/?q=' },
  ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
  discogs: { label: 'Discogs', url: 'https://www.discogs.com/search/?type=all&q=' },
  musicbrainz: { label: 'MusicBrainz', url: 'https://musicbrainz.org/search?type=recording&query=' },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

const KEY = 'subwave.admin.eraSearchEngine';

export function isSearchEngine(v: unknown): v is SearchEngine {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, v);
}

export function loadSearchEngine(): SearchEngine {
  try {
    const v = window.localStorage.getItem(KEY);
    return isSearchEngine(v) ? v : 'google';
  } catch {
    return 'google';
  }
}

export function saveSearchEngine(v: SearchEngine): void {
  try { window.localStorage.setItem(KEY, v); } catch { /* private mode: this session only */ }
}

/** The engine's results page for `terms`. Directory sites (Discogs, MusicBrainz) drop the "release date" words, which only help a web search. */
export function buildSearchUrl(engine: SearchEngine, terms: string): string {
  const e = SEARCH_ENGINES[engine];
  const q = engine === 'discogs' || engine === 'musicbrainz' ? terms.replace(/\s*release date$/, '') : terms;
  return e.url + encodeURIComponent(q.trim());
}
