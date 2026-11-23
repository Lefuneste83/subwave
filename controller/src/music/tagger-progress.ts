// Structured progress channel from the tagger/analyzer children: one sentinel
// line per update on stdout, parsed by broadcast/tagger.ts into `tagger.progress`.
// Dependency-free so both the CLI scripts and the server can import it.
export const PROGRESS_PREFIX = '[progress] ';

export type TaggerPhase =
  | 'walk'
  | 'enrich'
  | 'embed'
  | 'seed'
  | 'propagate'
  | 'learn'
  | 'analyze'
  | 'done';

export interface TaggerProgress {
  phase: TaggerPhase;
  // Authored here so the UI needs no phase->label map.
  label: string;
  done?: number;
  // Absent total = indeterminate (the Navidrome walk reports no count up front).
  total?: number;
  // Active-learning round (phase 'learn' only).
  round?: number;
  // Cumulative failures within the current phase.
  errors?: number;
  // Per-leg tagged counts when dual-LLM mode is draining the batch queue.
  llm?: { legs: Record<string, number> };
  // Cumulative wall-clock per phase in ms. Attached to the terminal 'done' event
  // only; absent on in-flight events.
  timings?: Record<string, number>;
  updatedAt: string;
}

export function reportProgress(p: Omit<TaggerProgress, 'updatedAt'>): void {
  console.log(PROGRESS_PREFIX + JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
}

// Second sentinel channel: discrete typed status events, so the panel renders by
// kind instead of regex-scraping log lines (a song title containing "failed" used
// to read as a failure).
export const EVENT_PREFIX = '[event] ';

export type TaggerEventKind = 'info' | 'success' | 'warning' | 'error';

export interface TaggerEvent {
  kind: TaggerEventKind;
  // Operator-facing sentence, composed at the call site.
  text: string;
  at: string;
  // The run held something back for the operator (a mass removal, a mass
  // replaced-file clear). Kept once the run ends (broadcast/tagger.ts `holds`),
  // because such a run still exits 0 and nothing else would say so.
  hold?: boolean;
}

export function reportEvent(e: Omit<TaggerEvent, 'at'>): void {
  console.log(EVENT_PREFIX + JSON.stringify({ ...e, at: new Date().toISOString() }));
}

// Adoption is phase 0 of a potentially long run. Tell the controller as soon
// as the recovery map is durable so track blocks/likes/pins follow the new IDs.
// The exit and boot hooks also replay it if this notification is lost.
export const ROTATION_PREFIX = '[rotation] ';

export interface TaggerRotation {
  adopted: number;
  at: string;
}

export function reportRotation(r: Omit<TaggerRotation, 'at'>): void {
  console.log(ROTATION_PREFIX + JSON.stringify({ ...r, at: new Date().toISOString() }));
}

// A nonempty authoritative walk has finished adoption AND pruning. Consumers
// may now rebuild without waiting for enrichment/tagging/analysis to finish.
// Separate from [rotation], which can arrive before pruning and is only a
// notification that the journal is durable.
export const CATALOGUE_PREFIX = '[catalogue] ';

export function reportCatalogueReady(walked: number): void {
  console.log(CATALOGUE_PREFIX + JSON.stringify({ walked }));
}

// Set on a controller-spawned child's env (broadcast/tagger.ts): the controller
// reads this child's stdout and relays the sentinels. Re-exported by
// tagger-lock.ts, which reads it for the pidfile.
export const MANAGED_ENV = 'SUBWAVE_TAGGER_MANAGED';

// Whether this process's stdout is read by the controller. Each status line is
// then emitted ONCE, as the event sentinel the panel and the run's log file
// render; run from a shell (`npm run tag-library` / `npm run analyze`), once,
// as the plain line the operator reads. Never both: a plain echo before each
// sentinel was the source of every doubled line in the run log, whenever the
// capture side failed to pair the two (any prefix it did not know).
export function eventsAreRelayed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_ENV] === '1';
}

// A run-log line (music/run-log-format.ts) carries its own mark or its own
// indentation: the panel and the log file add no kind prefix to it.
// MIRROR: web/components/admin/LibraryTaggingPanel.tsx `carriesOwnMark`.
const OWN_MARK_RE = /^(?:\s|━━|[▶▷✔⚠✖…■])/;
export function carriesOwnMark(text: string): boolean {
  return OWN_MARK_RE.test(text);
}

// Bind an event logger to a module's console tag ('tag' / 'analyze'): the
// terse `[tag] …` line in a shell, the event sentinel under the controller
// (eventsAreRelayed). New status lines go through music/run-log.ts instead,
// which words them in the run log's one format.
export function makeEventLogger(prefix: string) {
  return (kind: TaggerEventKind, text: string, opts: { hold?: boolean } = {}): void => {
    // Collapse newlines: one event is one line.
    const line = text.replace(/\s*\n\s*/g, ' ');
    if (eventsAreRelayed()) reportEvent({ kind, text: line, ...opts });
    else console.log(`[${prefix}] ${line}`);
  };
}

// Slowest-first, zero-duration phases dropped. Shared by the CLI breakdown line
// and the 'done' event's `timings` so the two can't drift.
export function sortedPhaseTimings(timings: Record<string, number>): Array<[string, number]> {
  return Object.entries(timings)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);
}

// e.g. "seed 480s · learn 360s · embed 120s"; '' when nothing was timed.
export function formatPhaseBreakdown(timings: Record<string, number>): string {
  return sortedPhaseTimings(timings)
    .map(([p, ms]) => `${p} ${Math.round(ms / 1000)}s`)
    .join(' · ');
}
