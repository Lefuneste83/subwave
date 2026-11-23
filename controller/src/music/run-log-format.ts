// The run log's wording: the one place a tagging or analysis run's lines are
// worded and shaped (docs/internals/music.md → "The run log"). Every phase of
// `npm run tag-library` / `npm run analyze` (and the admin's Start tagging /
// Analyze audio, which spawn them) reports through music/run-log.ts, which
// takes its lines from here, so a phase never builds its own strings and every
// step reads the same way:
//
//   ▶ [3/9] Measure loudness and silence at both ends
//       Runs on : analyzer at analyzer.local:8080 · CPU lane, 12 at a time
//       Scope   : 29 tracks missing it, out of 74,725 in the library
//     … 25/29 done
//   ✔ [3/9] Measure loudness and silence at both ends — 29 done, 0 failed · 37 s
//
// Plain English, no internal names: a step is named by what it produces, the
// machine by the host the operator configured (never a credential or a query
// string), and a problem by its cause and its fix. Tuning numbers stay out of
// the normal log (run-log.ts `debug`). Pure: no I/O, no settings, so every
// shape is pinned by scripts/run-log-format.test.ts.
//
// Each line starts with one of the marks below or with indentation; the
// admin's log panel and the run's log file recognise that (tagger-progress.ts
// `carriesOwnMark`) and add no prefix of their own.

export const MARK = {
  banner: '━━',
  start: '▶',
  skip: '▷',
  ok: '✔',
  warn: '⚠',
  fail: '✖',
  progress: '…',
  end: '■',
} as const;

export type Outcome = 'ok' | 'partial' | 'failed';
export type ProblemKind = 'error' | 'warning';

const INDENT = '    ';

export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

function tracks(n: number): string {
  return `${fmtCount(n)} track${n === 1 ? '' : 's'}`;
}

// 37 s · 2 min 34 s · 2 h 1 min. Seconds are dropped past an hour.
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

// host[:port] of a configured URL. Never the userinfo, path or query string:
// a Navidrome or analyzer URL can carry credentials (`?auth=`, `user:pass@`).
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

export function stepTag(n: number, total: number): string {
  return `[${n}/${total}]`;
}

export interface StepRef {
  n: number;
  total: number;
  title: string;
}

export function headerLines(h: StepRef & { runsOn?: string | null; scope?: string | null }): string[] {
  const lines = [`${MARK.start} ${stepTag(h.n, h.total)} ${h.title}`];
  if (h.runsOn) lines.push(`${INDENT}Runs on : ${oneLine(h.runsOn)}`);
  if (h.scope) lines.push(`${INDENT}Scope   : ${oneLine(h.scope)}`);
  return lines;
}

export function skipLine(s: StepRef & { reason: string }): string {
  return `${MARK.skip} ${stepTag(s.n, s.total)} ${s.title} — skipped: ${oneLine(s.reason)}`;
}

export function progressLine(done: number, total: number): string {
  return `  ${MARK.progress} ${fmtCount(done)}/${fmtCount(total)} done`;
}

// Progress with no total known up front (the library walk).
export function progressCountLine(done: number, what: string): string {
  return `  ${MARK.progress} ${fmtCount(done)} ${what}`;
}

// An indented line under the current step: a detail of its scope or result.
export function detailLine(text: string): string {
  return `${INDENT}${oneLine(text)}`;
}

const OUTCOME_MARK: Record<Outcome, string> = { ok: MARK.ok, partial: MARK.warn, failed: MARK.fail };

export function resultLine(r: StepRef & { outcome: Outcome; summary: string; ms: number }): string {
  const summary = oneLine(r.summary);
  return `${OUTCOME_MARK[r.outcome]} ${stepTag(r.n, r.total)} ${r.title}${summary ? ` — ${summary}` : ''} · ${fmtDuration(r.ms)}`;
}

export interface Counts {
  done: number;
  failed: number;
  // Tracks the step could not do this run, for a reason that is not theirs
  // (a share not mounted): they stay due.
  left?: { count: number; why: string } | number;
}

function leftCount(c: Counts): number {
  return typeof c.left === 'number' ? c.left : c.left?.count ?? 0;
}

export function outcomeOf(c: Counts): Outcome {
  if (c.failed > 0 && c.done === 0) return 'failed';
  if (c.failed > 0 || leftCount(c) > 0) return 'partial';
  return 'ok';
}

export function countsSummary(c: Counts): string {
  const base = `${fmtCount(c.done)} done, ${fmtCount(c.failed)} failed`;
  const left = leftCount(c);
  if (left === 0) return base;
  const why = typeof c.left === 'object' && c.left.why ? ` (${c.left.why})` : '';
  return `${base}, ${fmtCount(left)} left for later${why}`;
}

// The embed steps: new tracks, analysed tracks whose sound line changed, or a
// whole rebuild.
export function embedScope(s: { tracks: number; pool: number; kind: 'new' | 'marked' | 'rebuild' }): string {
  const what = s.kind === 'marked' ? 'whose sound description changed'
    : s.kind === 'rebuild' ? 'to rebuild' : 'without a similarity vector';
  return `${tracks(s.tracks)} ${what}, out of ${fmtCount(s.pool)} in the library`;
}

export function embeddingFailedProblem(where: string, error: string): string {
  return `Building similarity vectors failed: ${where} answered "${shorten(error, 120)}". ` +
    'Check that the embedding server is running and the model is available, then run Start tagging again.';
}

// Mood tagging: how many the LLM is asked, and how it went.
export function tagScope(s: { asked: number; newTracks: number }): string {
  return s.asked === s.newTracks
    ? `${tracks(s.asked)} to ask the LLM about`
    : `${tracks(s.asked)} to ask the LLM about, a sample of the ${fmtCount(s.newTracks)} new ones (the rest get their moods from similar tracks)`;
}

export function tagResult(s: { asked: number; tagged: number; untaggable: number; calls: number }): { summary: string; outcome: Outcome } {
  const failed = Math.max(0, s.asked - s.tagged - s.untaggable);
  return {
    summary: `${fmtCount(s.tagged)} tagged, ${fmtCount(failed)} failed` +
      (s.untaggable ? `, ${fmtCount(s.untaggable)} the model could not tell` : '') +
      ` · ${fmtCount(s.calls)} LLM call${s.calls === 1 ? '' : 's'}`,
    outcome: outcomeOf({ done: s.tagged, failed }),
  };
}

// Spreading moods to similar tracks.
export function spreadResult(s: { spread: number; unsure: number; rounds: number; considered: number }): string {
  return `${fmtCount(s.spread)} of ${fmtCount(s.considered)} got their moods from similar tracks, ${fmtCount(s.unsure)} still unsure` +
    (s.rounds ? ` after ${s.rounds} round${s.rounds === 1 ? '' : 's'} of asking the LLM again` : '');
}

// The library walk.
export function walkScope(known: number): string {
  return known > 0 ? `the whole library (${fmtCount(known)} tracks known before this run)` : 'the whole library (first read)';
}

// A walk that stopped part-way: nothing is removed on an incomplete read.
export function walkStoppedProblem(walked: number, why: string): string {
  return `The library walk stopped after ${tracks(walked)} (${shortenAnalyzerMessage(why)}), so nothing was removed this run.`;
}

export function walkSummary(s: { walked: number; newTracks?: number }): string {
  return [`${tracks(s.walked)} read`, s.newTracks ? `${fmtCount(s.newTracks)} new to tag` : ''].filter(Boolean).join(', ');
}

// Tracks re-linked after a Navidrome ID change, and tracks removed: one line
// each under the walk, only when there are any.
export function walkChangeLines(s: { adopted: number; pruned: number }): string[] {
  return [
    s.adopted ? `Re-linked: ${tracks(s.adopted)} whose Navidrome ID changed — their tags and analysis are kept` : '',
    s.pruned ? `Removed: ${tracks(s.pruned)} no longer in Navidrome` : '',
  ].filter(Boolean);
}

// Tracks on albums whose year looks like a reissue's (the walk's era check).
export function eraSuspectLine(n: number): string {
  return `Release years: ${tracks(n)} ${n === 1 ? 'is' : 'are'} on compilations or reissues, so their album year is not used — ` +
    `an original-year lookup is queued for ${n === 1 ? 'it' : 'them'}`;
}

// The replaced-file check at the end of the walk (replaced-file-policy.ts):
// what it found and did, in one line. The signal counts are debug.
export interface ReplacedCheck {
  walkedNothing?: boolean;
  // Navidrome's change times: null when they could not be read (size only).
  changeTimes: { complete: boolean; futureDated: number } | null;
  replaced: number;
  stems?: { removed: number; failed: number; offline?: string };
  accepted?: { count: number; resent: number };
  held?: number;
}

export function replacedFilesLine(c: ReplacedCheck): string {
  if (c.walkedNothing) return 'Replaced files: not checked (the walk read nothing)';
  let what: string;
  if (c.held) what = `${fmtCount(c.held)} found — on hold until you answer (see the warning)`;
  else if (c.accepted?.count) {
    what = `${fmtCount(c.accepted.count)} accepted as they are — their analysis is kept` +
      (c.accepted.resent ? `, ${fmtCount(c.accepted.resent)} with a new size ${c.accepted.resent === 1 ? 'gets its' : 'get their'} stems separated again` : '');
  } else if (c.replaced) {
    what = `${fmtCount(c.replaced)} (same path, new audio) — their analysis is due again` +
      (c.stems?.removed ? `, ${fmtCount(c.stems.removed)} stem set${c.stems.removed === 1 ? '' : 's'} dropped` : '') +
      (c.stems?.failed ? `, ${fmtCount(c.stems.failed)} stem folder${c.stems.failed === 1 ? '' : 's'} could not be removed` : '') +
      (c.stems?.offline ? ` (the stems share is offline: ${shorten(c.stems.offline, 80)})` : '');
  } else what = c.changeTimes ? 'none since the last run' : 'none found';
  const notes = [
    c.changeTimes ? '' : 'checked by file size only — Navidrome\'s change times could not be read (the server is not Navidrome or did ' +
      'not answer, its API refused or timed out, or the station kept the password back)',
    c.changeTimes && !c.changeTimes.complete ? 'the change list was only partly read, so the next run reads it again' : '',
    c.changeTimes?.futureDated ? `${fmtCount(c.changeTimes.futureDated)} file${c.changeTimes.futureDated === 1 ? '' : 's'} dated in the future skipped (a wrong clock on the files)` : '',
  ].filter(Boolean);
  // A size-only check joins its finding with a comma; the others are asides.
  if (!c.changeTimes) return `Replaced files: ${what}, ${notes.join(' · ')}`;
  return `Replaced files: ${[what, ...notes].join(' · ')}`;
}

export function replacedFilesDebug(d: { read: number; since: string | null; bySize: number; byTime: number }): string {
  return `replaced-file check: ${fmtCount(d.read)} change times read since ${d.since ?? 'the start'}; ` +
    `${d.bySize} by size, ${d.byTime} by change time`;
}

export function yearsSummary(s: { asked: number; found: number; notFound: number; errors: number; discogs?: number }): string {
  return `${fmtCount(s.found)} of ${fmtCount(s.asked)} found` + (s.discogs ? ` (${fmtCount(s.discogs)} from Discogs)` : '') +
    `, ${fmtCount(s.notFound)} not found` +
    (s.errors ? `, ${fmtCount(s.errors)} lookups failed (retried later: 1 h, 1 day, then 7 days)` : '');
}

// The enrich step: what it fetches from each source this run, and what it found.
export interface EnrichSwitches { lastfm: boolean; lyrics: boolean; years: boolean }

export function enrichScope(s: EnrichSwitches & { metaTracks: number; trackTags: number; yearTracks: number; pool: number }): string {
  const parts = [
    s.lastfm && s.metaTracks ? `for Last.fm tags` : '',
    s.trackTags ? `${fmtCount(s.trackTags)} for their own Last.fm track tags` : '',
    s.lyrics && s.metaTracks ? `for lyrics` : '',
    s.yearTracks ? `${fmtCount(s.yearTracks)} for an original release year` : '',
  ].filter(Boolean);
  // "29 for Last.fm tags, 29 for lyrics": the shared count is said each time.
  const said = parts.map(p => (p.startsWith('for ') ? `${fmtCount(s.metaTracks)} ${p}` : p));
  if (said.length === 0) return `nothing, out of ${fmtCount(s.pool)} in the library`;
  said[0] = said[0].replace(/^([\d,]+) /, (_m, n) => `${n} track${n === '1' ? '' : 's'} `);
  return `${said.join(', ')}, out of ${fmtCount(s.pool)} in the library`;
}

export function enrichSummary(s: EnrichSwitches & {
  tracks: number; tagsFound: number; lyricsFound: number; yearLookups: { asked: number; found: number; errors: number };
}): string {
  return [
    s.lastfm && s.tracks ? `Last.fm tags for ${fmtCount(s.tagsFound)} of ${fmtCount(s.tracks)}` : '',
    s.lyrics && s.tracks ? `lyrics for ${fmtCount(s.lyricsFound)} of ${fmtCount(s.tracks)}` : '',
    s.yearLookups.asked ? `original release years for ${fmtCount(s.yearLookups.found)} of ${fmtCount(s.yearLookups.asked)}` +
      (s.yearLookups.errors ? ` (${fmtCount(s.yearLookups.errors)} lookups failed, retried later)` : '') : '',
  ].filter(Boolean).join(', ') || 'nothing fetched';
}

// An analysis step's result: the counts, then what it wrote.
export function analysisSummary(s: Counts & { products: Array<[string, number]> }): string {
  const products = s.products.filter(([, n]) => n > 0).map(([what, n]) => `${fmtCount(n)} ${what}`);
  return countsSummary(s) + (products.length ? ` · ${products.join(', ')}` : '');
}

export function problemLine(kind: ProblemKind, text: string): string {
  return `${kind === 'error' ? MARK.fail : MARK.warn} ${oneLine(text)}`;
}

// "29 tracks missing it, out of 74,725 in the library".
export function scopeMissing(s: { missing: number; pool: number; what?: string }): string {
  return `${tracks(s.missing)} missing ${s.what ?? 'it'}, out of ${fmtCount(s.pool)} in the library`;
}

// "29 of 74,725 tracks in the library — 29 need intro, tempo and key, 29 outro".
// Products nobody needs are left out.
export function scopeProducts(s: { tracks: number; pool: number; needs: Array<[string, number]> }): string {
  const needs = s.needs.filter(([, n]) => n > 0).map(([what, n], i) => `${fmtCount(n)} ${i === 0 ? 'need ' : ''}${what}`);
  return `${fmtCount(s.tracks)} of ${fmtCount(s.pool)} tracks in the library` + (needs.length ? ` — ${needs.join(', ')}` : '');
}

// What each analysis product is called in the log, by what it gives the station.
export const PRODUCT: Record<string, string> = {
  head: 'intro, tempo and key',
  tail: 'outro',
  loudness: 'loudness',
  edges: 'silence at both ends',
  clap: 'sounds-like',
  vocal: 'vocals',
  stems: 'stems',
  grid: 'beat grid',
  structure: 'phrase structure',
  year: 'original year',
};

// The model lane's step title, naming every product the one request covers.
export function modelLaneTitle(w: { clap: boolean; vocal: boolean; stems: boolean }): string {
  const parts = ['Find the intro, outro, tempo and key'];
  if (w.clap) parts.push('sounds-like fingerprint (CLAP)');
  if (w.vocal && w.stems) parts.push('vocals and stems for blends (Demucs)');
  else if (w.vocal) parts.push('vocals (Demucs)');
  else if (w.stems) parts.push('stems for blends (Demucs)');
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The title of an explicit `--facets` plan.
export function facetPlanTitle(facets: readonly string[]): string {
  const names = facets.filter((f) => f !== 'year').map((f) => PRODUCT[f] ?? f);
  if (names.length === 0) return 'Look up original years';
  return `Measure ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
}

// Where an analysis step runs: "analyzer at analyzer.local:8080 · GPU models lane, 4 at a time".
export function runsOnAnalyzer(a: { where: string; lane: 'models' | 'cpu'; concurrency: number }): string {
  const lane = a.lane === 'models' ? 'GPU models lane' : 'CPU lane';
  return `${a.where} · ${lane}, ${a.concurrency} at a time`;
}

// The steps' names, by what each one produces.
export const STEP_TITLE = {
  walk: 'Read the music library',
  spread: 'Spread moods to similar tracks',
  selfCheck: 'Quality self-check',
  energy: 'Check energies against the audio',
  lead: 'Measure loudness and silence at both ends, for the tracks about to be analysed',
  backlog: 'Measure loudness and silence at both ends, for the rest of the library',
  score: 'Score moods, sound descriptors and energies from the audio (CLAP)',
  grid: 'Beat grid for Hot Mix (Beat This)',
  structure: 'Phrase structure for Hot Mix',
  refresh: 'Refresh the similarity vectors of the analysed tracks',
  years: 'Look up original release years',
} as const;

export function enrichTitle(on: EnrichSwitches): string {
  const parts = [on.lastfm && 'Last.fm tags', on.lyrics && 'lyrics', on.years && 'original release years'].filter(Boolean) as string[];
  if (parts.length === 0) return 'Fetch track details';
  return `Fetch ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`;
}

// The audio scoring step: what needs scoring, and what it did.
export function scoreScope(s: { vectors: number; moods: number; descriptors: number }): string {
  return `${fmtCount(s.moods)} fingerprints need mood scores, ${fmtCount(s.descriptors)} need sound descriptors, ` +
    `out of ${fmtCount(s.vectors)} sounds-like fingerprints`;
}

export interface ScoreStats {
  scored: number;
  relabelled?: number;
  skipped: string | null;
}

function scoreReason(s: ScoreStats): string | null {
  if (s.skipped === 'no text tower') return 'the analyzer has no CLAP text model (ANALYZER_HEAVY=1 adds it)';
  if (s.skipped === 'text embedding failed') return 'the analyzer\'s CLAP text model failed (see its log)';
  return s.skipped && s.skipped !== 'no audio vectors' ? s.skipped : null;
}

// A relabel (labels re-derived from stored scores after a calibration
// change) is internal: the result counts tracks scored, and the reporter's
// debug line carries the rest.
function scoredPart(what: string, s: ScoreStats): string {
  return `${fmtCount(s.scored)} ${what}`;
}

export function scoreSummary(s: { moods: ScoreStats; descriptors: ScoreStats; energy: string | null }): string {
  const passes = [s.moods, s.descriptors];
  const reasons = passes.map(scoreReason);
  const idle = (p: ScoreStats) => p.skipped === 'no audio vectors' || (!p.skipped && p.scored === 0);
  let scoring: string;
  if (reasons[0] && reasons[0] === reasons[1]) scoring = `moods and sound descriptors not scored: ${reasons[0]}`;
  else if (passes.every(idle)) scoring = passes.some(p => p.skipped === 'no audio vectors') ? '' : 'no new fingerprints to score';
  else {
    scoring = [
      reasons[0] ? `moods not scored: ${reasons[0]}` : scoredPart('scored for moods', s.moods),
      reasons[1] ? `sound descriptors not scored: ${reasons[1]}` : scoredPart('for sound descriptors', s.descriptors),
    ].join('; ');
  }
  return [scoring, s.energy].filter(Boolean).join('; ');
}

// The energy check's result, in the order its three steps run; only the
// switches that are on are named. A pass with nothing in scope and no switch
// on is a skip.
export interface EnergyStats {
  scope: number; corrected: number; agreed: number; undecided: number;
  fillScope?: number; filled?: { high: number; medium: number; low: number };
  overruleScope?: number; overruled?: number; skipped: string | null;
}

export function energyResult(s: EnergyStats): { skip: string } | { summary: string } {
  const switches = s.fillScope !== undefined || s.overruleScope !== undefined;
  if (s.skipped && !switches) return { skip: s.skipped };
  const parts: string[] = [];
  parts.push(s.scope === 0 ? 'no copied energies to check'
    : `energies copied from similar tracks: ${fmtCount(s.corrected)} of ${fmtCount(s.scope)} corrected from the audio, ` +
      `${fmtCount(s.agreed)} confirmed, ${fmtCount(s.undecided)} kept (the audio is not clear-cut)`);
  if (s.filled && s.fillScope !== undefined) {
    const n = s.filled.high + s.filled.medium + s.filled.low;
    parts.push(s.fillScope === 0 ? 'no missing energies to fill'
      : `${fmtCount(n)} of ${fmtCount(s.fillScope)} missing energies filled from the audio (${fmtCount(s.filled.high)} high, ` +
        `${fmtCount(s.filled.medium)} medium, ${fmtCount(s.filled.low)} low)`);
  }
  if (s.overruled !== undefined && s.overruleScope !== undefined) {
    parts.push(s.overruleScope === 0 ? 'no LLM energies to check'
      : `${fmtCount(s.overruled)} of ${fmtCount(s.overruleScope)} LLM energies changed where the audio clearly says otherwise`);
  }
  return { summary: parts.join('; ') };
}

// ── Problems: one sentence for the cause, one for the fix ──────────────────

function shorten(msg: string, max = 140): string {
  const first = oneLine(String(msg).split(/\n\s*(?:Traceback|File ")/)[0]);
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export const shortenAnalyzerMessage = shorten;

// What holds the failed load: the analyzer container (it remembers the failure
// across worker respawns), or the controller itself on a local/AIO install.
function restartHint(backend: string | null | undefined): string {
  if (backend === 'local') return 'Restart the controller (it runs the analyzer itself)';
  if (backend === 'sidecar') return 'Restart the analyzer';
  return 'Restart the analyzer (or the controller, if it runs the analyzer itself)';
}

// A model the analyzer could not load (`/health` analyze_*_error), or an image
// built without it (error null).
export function modelProblem(p: { product: string; model: string; error: string | null; backend: string | null }): string {
  if (p.error) {
    const gpu = /cuda|gpu|out of memory/i.test(p.error);
    return `${p.product} skipped: ${p.model} failed to load on the analyzer (${shorten(p.error)}). ` +
      `${restartHint(p.backend)} once ${gpu ? 'the GPU is free' : 'the cause is fixed'}, then run Start tagging again; ` +
      'until then the tracks stay due.';
  }
  return `${p.product} skipped: this analyzer is built without ${p.model}. ` +
    'Set ANALYZER_HEAVY=1 and recreate the analyzer, or run the -heavy AIO image.';
}

export const STEMS_MARKER_NAME = '.subwave-stems';

// The worker answers a stems request whose cache root has no marker with
// `unavailable` and a reason naming the marker (analyze_worker.py
// analyze_facets); that is the analyzer's own view of the share, which can
// differ from the controller's.
export function isStemsShareMissing(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.includes(STEMS_MARKER_NAME) && /marker/.test(reason);
}

export function stemsShareMissingProblem(root: string): string {
  return `Stems not saved: the analyzer cannot see the stems share (${root} has no ${STEMS_MARKER_NAME} marker). ` +
    'Mount the share on the analyzer host, then run Start tagging again.';
}

export function sharedStateProblem(trackCount: number, stateRoot: string): string {
  return `Stems skipped for ${tracks(trackCount)}: the analyzer cannot read the station's state folder (${stateRoot}), ` +
    'so its shared mount on the analyzer host is down or points elsewhere. ' +
    'Mount it there and restart the analyzer; the tracks are asked again next run.';
}

export function analyzerUnreachableProblem(host: string | null): string {
  return `No audio analysis this run: the analyzer${host ? ` at ${host}` : ''} did not answer. ` +
    'If this station has an analyzer, check that it is running and reachable from the controller, then run Start tagging again.';
}

export function musicServerUnreachableProblem(host: string | null, error: string): string {
  return `The music server${host ? ` at ${host}` : ''} could not be read (${shorten(error)}). ` +
    'Check that it is running and that the station can reach it, then run Start tagging again.';
}

export interface PlainFailure {
  cause: string;
  fix: string;
}

// An analysis failure in plain words, when its message is one the analyzer or
// the network gives; null for a track's own problem (no beat found…), which is
// reported as it is.
export function plainFailure(reason: string): PlainFailure | null {
  const r = String(reason);
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|fetch failed/i.test(r)) {
    return { cause: 'the analyzer did not answer', fix: 'Check that the analyzer is running and reachable, then run Start tagging again.' };
  }
  if (/exited with code|worker (?:died|crashed|exited)|BrokenProcessPool|terminated abruptly|killed/i.test(r)) {
    return { cause: "the analyzer's worker crashed", fix: 'Check the analyzer log for the crash (often memory); the tracks are asked again next run.' };
  }
  if (/out of memory|CUDA error|OOM/i.test(r)) {
    return { cause: 'the analyzer ran out of GPU memory', fix: 'Free the GPU or lower ANALYZE_CONCURRENCY, then restart the analyzer.' };
  }
  if (/timed? ?out|timeout|aborted/i.test(r)) {
    return { cause: 'the analyzer took too long to answer', fix: 'The analyzer may be overloaded; the tracks are asked again next run.' };
  }
  const http = /sidecar (5\d\d)/.exec(r);
  if (http) {
    return { cause: `the analyzer answered with an error (HTTP ${http[1]})`, fix: 'Check the analyzer log; the tracks are asked again next run.' };
  }
  return null;
}

// The failure reason a result line lists: plain when known, else the
// analyzer's own words, shortened.
export function failureReason(reason: string): string {
  return plainFailure(reason)?.cause ?? shorten(reason, 120);
}

export function systemicFailureProblem(run: number, lastReason: string): string {
  const plain = plainFailure(lastReason);
  return `${fmtCount(run)} tracks in a row failed to analyse: ${plain?.cause ?? shorten(lastReason, 120)}. ` +
    'This looks like a problem with the analyzer or the music server, not the files, so these failures are not held ' +
    `against the tracks until one analyses again. ${plain?.fix ?? 'Check that the analyzer and the music server are reachable.'}`;
}

// The library as the run leaves it, for the closing block. 'uncertain-llm' is
// the LLM's answer for a track its similar tracks could not settle: by the LLM,
// all the same.
const SOURCE_NAME: Record<string, string> = {
  llm: 'by the LLM', 'uncertain-llm': 'by the LLM', propagated: 'from similar tracks', manual: 'by hand', 'legacy-v1': 'by an older tagger',
};

export function librarySummary(s: { tagged: number; moods: number; genres: number; embedded: number; bySource: Record<string, number> }): string {
  const by = new Map<string, number>();
  for (const [k, n] of Object.entries(s.bySource)) {
    if (n > 0) by.set(SOURCE_NAME[k] ?? k, (by.get(SOURCE_NAME[k] ?? k) ?? 0) + n);
  }
  const sources = [...by].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${fmtCount(n)} ${name}`);
  return `${fmtCount(s.tagged)} tracks tagged${sources.length ? ` (${sources.join(', ')})` : ''} · ` +
    `${fmtCount(s.embedded)} with similarity vectors · ${s.moods} mood${s.moods === 1 ? '' : 's'} · ${s.genres} genre${s.genres === 1 ? '' : 's'}`;
}

// After the analysis, tracks that got their moods from similar tracks get them
// again over their new sounds-like fingerprints.
export function redoneFromSimilarLine(changed: number, of: number): string {
  return `Moods from similar tracks redone with the new sound fingerprints: ${fmtCount(changed)} of ${fmtCount(of)} changed`;
}

export function redoneFromSimilarFailed(error: string): string {
  return `Redoing the moods of the analysed tracks from their similar tracks failed (${shorten(error, 120)}); the next run tries again.`;
}

// The quality self-check (propagation-eval.ts): tracks already tagged, tagged
// again from their similar tracks alone, and compared with what they hold.
export function selfCheckScope(): string {
  return 'a sample of tracks already tagged, tagged again from their similar tracks alone and compared';
}

export function selfCheckSummary(s: { sampled: number; gatePassed: number; moodJaccard: number | null; energyMatched: number; energyComparable: number }): string {
  if (s.sampled === 0) return 'nothing to compare against (not enough trusted tags)';
  const pct = (n: number, d: number) => `${Math.round((n / Math.max(1, d)) * 100)}%`;
  const matches = [
    s.moodJaccard != null ? `moods match ${Math.round(s.moodJaccard * 100)}%` : '',
    s.energyComparable > 0 ? `energy ${pct(s.energyMatched, s.energyComparable)}` : '',
  ].filter(Boolean);
  return `${fmtCount(s.sampled)} tracks compared: similar tracks alone could tag ${pct(s.gatePassed, s.sampled)} of them` +
    (matches.length ? `; for those, ${matches.join(' and ')}` : '');
}

// ── Opening and closing blocks ─────────────────────────────────────────────

export function bannerLines(b: { title: string; steps: string[]; machines: string[] }): string[] {
  const lines = [`${MARK.banner} ${b.title} · ${b.steps.length} step${b.steps.length === 1 ? '' : 's'}`];
  b.steps.forEach((s, i) => lines.push(`${INDENT}${i + 1}. ${s}`));
  if (b.machines.length) lines.push(`${INDENT}Machines : ${b.machines.join(' · ')}`);
  return lines;
}

export interface SummaryStep {
  n: number;
  title: string;
  ms: number | null;
  outcome: Outcome | 'skipped';
}

export function summaryLines(s: {
  totalMs: number;
  headline: string;
  steps: SummaryStep[];
  library: string;
  warnings: string[];
}): string[] {
  const lines = [`${MARK.end} Finished in ${fmtDuration(s.totalMs)}${s.headline ? ` — ${oneLine(s.headline)}` : ''}`];
  if (s.steps.length) {
    lines.push(`${INDENT}Step times :`);
    for (const st of s.steps) {
      const mark = st.outcome === 'skipped' ? MARK.skip : OUTCOME_MARK[st.outcome];
      lines.push(`${INDENT}  ${mark} [${st.n}] ${st.title} · ${st.outcome === 'skipped' || st.ms == null ? 'skipped' : fmtDuration(st.ms)}`);
    }
  }
  if (s.library) lines.push(`${INDENT}Library    : ${oneLine(s.library)}`);
  const warnings = [...new Set(s.warnings.map(oneLine))];
  if (warnings.length) {
    lines.push(`${INDENT}Warnings   : ${warnings.length}`);
    for (const w of warnings) lines.push(`${INDENT}  ${w.startsWith(MARK.fail) || w.startsWith(MARK.warn) ? w : `${MARK.warn} ${w}`}`);
  }
  return lines;
}
