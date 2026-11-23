// How the Library page's log box shows a line of the controller's run log
// (controller/src/music/run-log-format.ts, docs/internals/music.md → "The run
// log"). Such a line carries its own mark (▶ ▷ ✔ ⚠ ✖ … ■ ━━) or its own
// indentation, so the panel adds no emoji for its kind; a step's header and
// the run's opening and closing lines stand out from the detail under them.
// MIRROR: controller/src/music/tagger-progress.ts `carriesOwnMark`.

const OWN_MARK_RE = /^(?:\s|━━|[▶▷✔⚠✖…■])/;

export function carriesOwnMark(text: string): boolean {
  return OWN_MARK_RE.test(text);
}

export function isRunLogHeading(text: string): boolean {
  return /^(?:━━|▶|■)/.test(text);
}
