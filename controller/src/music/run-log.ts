// The run log's reporter: how a tagging or analysis run says what it is doing,
// step by step (docs/internals/music.md → "The run log"). Every phase goes
// through here and words nothing itself; the wording is run-log-format.ts.
//
// A run opens with `plan()` (the banner: every step in order, the machines
// once), then each step either runs (`start` → `progress`… → `done`) or is
// `skip`ped with its reason, keeping its number, and `finish()` closes with
// the summary. Problems are said once, with their cause and their fix, under
// the step they belong to (`step.problem`), or at run level (`problem`), and
// are repeated in the summary's warning list.
//
// Each line is emitted once (tagger-progress.ts eventsAreRelayed): under the
// controller as the event sentinel the admin panel and the run's log file
// render, from a shell as the plain line. Progress still also goes out on the
// machine-readable [progress] channel, which the panel's progress bar reads;
// that stays the phases' own `reportProgress` calls.
//
// One reporter per process: each CLI run is its own process. In-process
// tests call `resetRunLog()`.

import { eventsAreRelayed, reportEvent, type TaggerEventKind } from './tagger-progress.js';
import * as F from './run-log-format.js';

export interface StepDef {
  id: string;
  title: string;
}

export interface StepStart {
  runsOn?: string | null;
  scope?: string | null;
  // When the work began, for a step reported once it is over (the
  // self-check, which runs alongside the analysis).
  at?: number;
}

type Sink = (kind: TaggerEventKind, text: string, opts: { hold?: boolean }) => void;

const consoleSink: Sink = (kind, text, opts) => {
  if (eventsAreRelayed()) reportEvent({ kind, text, ...opts });
  else console.log(text);
};

let sink: Sink = consoleSink;

// Tests: capture every line (kind and text) instead of printing.
export function setRunLogSink(s: Sink | null): void {
  sink = s ?? consoleSink;
}

interface StepState {
  id: string;
  title: string;
  startedAt: number | null;
  ms: number | null;
  outcome: F.Outcome | 'skipped' | null;
  alongside?: string | null;
  // The last progress line said (F.progressDue).
  lastDone: number;
  lastAt: number;
}

// How a step closes: its own work time and what it ran alongside, for a step
// reported after the fact (the self-check, beside the analysis).
interface DoneTiming { ms?: number; alongside?: string }

export class Step {
  constructor(private readonly r: RunLog, private readonly st: StepState) {}

  get title(): string {
    return this.st.title;
  }

  get started(): boolean {
    return this.st.startedAt != null;
  }

  get finished(): boolean {
    return this.st.outcome != null;
  }

  private ref(): F.StepRef {
    return { n: this.r.numberOf(this.st), total: this.r.total(), title: this.st.title };
  }

  // A step's title can be settled once its scope is known (the model lane
  // names the products its plan asks for).
  retitle(title: string): this {
    if (!this.started && !this.finished) this.st.title = title;
    return this;
  }

  start(s: StepStart = {}): this {
    if (this.started) return this;
    this.st.startedAt = s.at ?? this.r.now();
    this.st.lastAt = this.st.startedAt;
    this.st.lastDone = 0;
    this.r.current = this.st;
    for (const line of F.headerLines({ ...this.ref(), runsOn: s.runsOn, scope: s.scope })) this.r.emit('info', line);
    return this;
  }

  note(text: string): void {
    this.r.emit('info', F.detailLine(text));
  }

  // Call as often as convenient: the line is said only when F.progressDue
  // says so, the one rule for every step.
  progress(done: number, total: number): void {
    if (this.r.progressDue(this.st, done, total)) this.r.emit('info', F.progressLine(done, total));
  }

  // No total to show (the library walk); `known` paces the lines when the
  // size is roughly known (the library before this run).
  progressCount(done: number, what: string, known: number | null = null): void {
    if (this.r.progressDue(this.st, done, known)) this.r.emit('info', F.progressCountLine(done, what));
  }

  problem(kind: F.ProblemKind, text: string, opts: { hold?: boolean } = {}): void {
    this.r.problem(kind, text, opts);
  }

  // Close the step with its counts (outcome from them), or a summary of its own.
  done(result: (F.Counts | { summary: string; outcome?: F.Outcome }) & DoneTiming): void {
    if (this.finished) return;
    if (!this.started) this.start();
    const counts = 'done' in result && 'failed' in result ? result : null;
    const outcome = counts ? F.outcomeOf(counts) : (result as { outcome?: F.Outcome }).outcome ?? 'ok';
    const summary = counts ? F.countsSummary(counts) : (result as { summary: string }).summary;
    const now = this.r.now();
    this.st.ms = result.ms ?? now - (this.st.startedAt ?? now);
    this.st.alongside = result.alongside ?? null;
    this.st.outcome = outcome;
    if (this.r.current === this.st) this.r.current = null;
    this.r.emit(outcome === 'ok' ? 'success' : outcome === 'partial' ? 'warning' : 'error',
      F.resultLine({ ...this.ref(), outcome, summary, ms: this.st.ms, alongside: this.st.alongside }));
  }

  skip(reason: string): void {
    if (this.finished) return;
    if (this.started) {
      this.done({ summary: `stopped: ${reason}`, outcome: 'partial' });
      return;
    }
    this.st.outcome = 'skipped';
    this.r.emit('info', F.skipLine({ ...this.ref(), reason }));
  }
}

export class RunLog {
  private steps: StepState[] = [];
  private warnings: string[] = [];
  private startedAt = Date.now();
  private origins: { new: Set<string>; replaced: Set<string> } | null = null;
  verbose = false;
  // The clock (tests set their own).
  now: () => number = () => Date.now();
  // The step that started last and is still open: a helper's progress() goes
  // under it.
  current: StepState | null = null;
  private loose: StepState = { id: '', title: '', startedAt: null, ms: null, outcome: null, lastDone: 0, lastAt: Date.now() };

  progressDue(st: StepState | null, done: number, total: number | null): boolean {
    const s = st ?? this.loose;
    const now = this.now();
    if (!F.progressDue({ done, total, lastDone: s.lastDone, sinceLastMs: now - s.lastAt })) return false;
    s.lastDone = done;
    s.lastAt = now;
    return true;
  }

  // Where this run's tracks come from (new this run, replaced files the walk
  // found), so an analysis step's scope can say so.
  setOrigins(o: { new: Iterable<string>; replaced: Iterable<string> }): void {
    this.origins = { new: new Set(o.new), replaced: new Set(o.replaced) };
  }

  originsOf(ids: readonly string[]): F.TrackOrigins | undefined {
    if (!this.origins) return undefined;
    const r = { new: 0, replaced: 0, other: 0 };
    for (const id of ids) {
      if (this.origins.new.has(id)) r.new += 1;
      else if (this.origins.replaced.has(id)) r.replaced += 1;
      else r.other += 1;
    }
    return r;
  }

  emit(kind: TaggerEventKind, text: string, opts: { hold?: boolean } = {}): void {
    sink(kind, text, opts);
  }

  numberOf(st: StepState): number {
    return this.steps.indexOf(st) + 1;
  }

  total(): number {
    return this.steps.length;
  }

  // The banner: the steps this run plans, in order, and the machines it uses.
  plan(title: string, steps: StepDef[], machines: string[]): void {
    for (const s of steps) this.steps.push({ id: s.id, title: s.title, startedAt: null, ms: null, outcome: null, lastDone: 0, lastAt: 0 });
    for (const line of F.bannerLines({ title, steps: steps.map(s => s.title), machines })) this.emit('info', line);
  }

  // The planned step `id` not yet closed, or a new one appended (a step the
  // plan could not foresee, or a second pass of the same step).
  step(id: string, title?: string): Step {
    const open = this.steps.find(s => s.id === id && s.outcome == null);
    if (open) return new Step(this, open);
    const st: StepState = { id, title: title ?? id, startedAt: null, ms: null, outcome: null, lastDone: 0, lastAt: 0 };
    this.steps.push(st);
    return new Step(this, st);
  }

  // Whether a step was planned for this run (open or closed).
  planned(id: string): boolean {
    return this.steps.some(s => s.id === id);
  }

  // Skip the planned steps among `ids` that are still open (never run), with
  // one reason: the steps a run could not reach.
  skipOpen(ids: readonly string[], reason: string): void {
    for (const st of this.steps) {
      if (ids.includes(st.id) && st.outcome == null && st.startedAt == null) new Step(this, st).skip(reason);
    }
  }

  problem(kind: F.ProblemKind, text: string, opts: { hold?: boolean } = {}): void {
    const line = F.problemLine(kind, text);
    this.warnings.push(line);
    this.emit(kind, line, opts);
  }

  // Tuning numbers and per-track detail: only with --verbose /
  // RUN_LOG_VERBOSE=1.
  debug(text: string): void {
    if (this.verbose) this.emit('info', F.detailLine(text));
  }

  // The closing block. Steps never reached are listed as skipped.
  finish(s: { headline: string; library: string }): void {
    const lines = F.summaryLines({
      totalMs: Date.now() - this.startedAt,
      headline: s.headline,
      steps: this.steps.map(st => ({
        n: this.numberOf(st),
        title: st.title,
        ms: st.ms,
        alongside: st.alongside,
        outcome: st.outcome == null || st.outcome === 'skipped' ? 'skipped' : st.outcome,
      })),
      library: s.library,
      warnings: this.warnings,
    });
    for (const line of lines) this.emit('info', line);
  }
}

export let runLog = new RunLog();
runLog.verbose = verboseRequested();

export function verboseRequested(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--verbose') || env.RUN_LOG_VERBOSE === '1';
}

export function resetRunLog(): RunLog {
  runLog = new RunLog();
  return runLog;
}

// Shorthands, so a phase reads `step('walk')` rather than reaching for the instance.
export function step(id: string, title?: string): Step {
  return runLog.step(id, title);
}

export function problem(kind: F.ProblemKind, text: string, opts: { hold?: boolean } = {}): void {
  runLog.problem(kind, text, opts);
}

export function debug(text: string): void {
  runLog.debug(text);
}

// A progress line for the step that is running, from a helper that does not
// hold the step.
export function progress(done: number, total: number): void {
  if (runLog.progressDue(runLog.current, done, total)) runLog.emit('info', F.progressLine(done, total));
}

// A detail line under the step that is running (a pause, a resume).
export function note(text: string): void {
  runLog.emit('info', F.detailLine(text));
}

// For a pass that reports inside the step that runs it (the zero-shot audio
// scoring): its problems are said, the rest is detail the step's result line
// already sums up.
export function stepDetail(kind: TaggerEventKind, text: string): void {
  if (kind === 'warning' || kind === 'error') runLog.problem(kind, text);
  else runLog.debug(text);
}
