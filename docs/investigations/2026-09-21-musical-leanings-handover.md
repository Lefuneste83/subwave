# Musical Leanings handover — 21 September 2026

## Purpose and current status

Musical Leanings remains an optional, separate presenter field for private
music-selection guidance. It is a soft editorial preference only: it must not
create candidates or override flow, show rules, rotation, safety, requests, or
the existing artist/album guards.

The station work established two different route contracts:

- **Track Shortlist** retains a controller-resolved `usedMusicalLeanings`
  diagnostic and the `LEANINGS` Debug badge.
- **Agentic Tools** deliberately has no Leanings provenance badge. The local
  model cannot reliably say whether Leanings caused a choice or accurately
  explain the claimed tie-break.

All work described below was live-tested on the station branch. The current
station-only commits must be sorted into the two review PRs before the branch
is retired.

## Agentic false-flag investigation

The original Agentic contract asked the model to return:

- `usedMusicalLeanings: boolean`; and
- `leaningsTieBreak: string | null`.

That was not reliable on the local Meta Llama 3.1 8B Instruct Q5_K_M model.
Observed failures included:

1. **Schema-example copying.** The example phrase `warm vocal and melodic
   hook` appeared in output even when it was not grounded in the candidate or
   presenter.
2. **Generic-flow relabelling.** Terms such as energy, mood, pace, and
   reflective/club feeling were returned as Leanings evidence. These overlap
   with show tags and normal selection context, rather than proving a
   presenter-preference tie-break.
3. **Profile echoing.** The model paraphrased the supplied Leanings in the
   private reason without making a reliable causal distinction.
4. **Unreliable omissions.** A model can select in the direction of a
   preference but return `usedMusicalLeanings: false`; conversely it can claim
   a tie-break where no grounded evidence exists.

The problem was amplified because Agentic saw Leanings more than once: in the
system prompt, in the newest pick event, and in a fresh diagnostic reminder.
The repeated text improved salience but made the model more likely to echo the
instruction and schema than to give factual provenance.

## Replay evidence

`controller/scripts/agentic-leanings-replay.ts` replays a saved Agentic turn
against the recorded discovery results. It neither queues music nor calls
Navidrome. The two checked fixtures are:

- `scripts/fixtures/agentic-leanings/maria-marcella-detroit.json`
- `scripts/fixtures/agentic-leanings/dante-porcupine-tree.json`

Important findings:

- The original Agentic diagnostic produced false Leanings claims for Dante
  (typically 5/5), and copied the schema example in some runs.
- Removing only `leaningsTieBreak` removed the copied wording but did not stop
  false boolean claims.
- A frozen candidate-final-selection experiment retained valid IDs and
  eliminated Dante's false Leanings claims by removing the diagnostic fields.
- In matched 20-call samples, Maria's Leanings-enabled final selection chose
  Phil Collins 13/20 times versus 7/20 in the no-Leanings control. Dante's
  result was essentially unchanged: R.E.M. was selected 17/20 in both arms.
  This is consistent with Leanings softly affecting a genuine choice in one
  fixture without overriding a stronger flow case in the other.
- The final model's boolean remained unusable: Maria reported the expected
  provenance only 2/20 times despite the measurable selection shift.

These experiments support the placement of Leanings beside an already
discovered candidate set. They do **not** justify a live per-pick causal badge.

## Current Agentic architecture

When the presenter has a non-blank Musical Leanings field:

```text
djAgentPick → djAgentEditorialPick → artist/album guards → queue
```

1. `djAgentPick` is discovery only. It sees the ordinary presenter Soul, but
   it receives no separate Musical Leanings prompt and has no Leanings
   diagnostic fields in its schema.
2. `djAgentEditorialPick` receives only the candidates actually surfaced by
   discovery, plus the resolved host/optional guest Leanings. It selects one
   of those exact IDs and writes a private, track-specific selection reason.
3. Existing artist and album guards may still make a constrained corrective
   re-pick. The flow never returns to `djAgentPick` for a second discovery
   decision.

If the Musical Leanings field is blank, `djAgentEditorialPick` is not called.
Agentic follows its ordinary one-step discovery-and-pick behaviour and still
sees any musical preferences the operator deliberately left in the presenter
Soul.

The editorial call must not claim that Leanings decided the pick. Its reason
is controller-sanitised before it reaches Booth/session text. Raw debug output
can still name the wrong track or mention Leanings; the controller-resolved ID
and verified reason are authoritative.

### Live smoke observations

The initial live sample completed the expected two-call sequence for every
Agentic run that surfaced usable candidates. A blank Leanings field was also
confirmed not to call `djAgentEditorialPick`.

The two-step arrangement was faster than the old local Agentic runs in the
small sample:

- previous `djAgentPick` average: about 32.3 s;
- new discovery average: about 15.3 s;
- editorial final selection average: about 5.2 s;
- combined average: about 20.5 s.

The three observed five-minute Agentic deadlines were attributed to local GPU
pressure in the looping discovery tools, not the editorial final-selection
step.

Useful future Debug improvement: compare the controller-resolved discovery
proposal with the controller-resolved editorial choice, and show a factual
indicator when the editorial pass changed the proposal. Do not label that as
proof that Leanings caused the change.

## Track Shortlist status

Shortlist's natural selection wording was restored to its pre-tie-break
behaviour after the Agentic tie-break contract leaked generic energy/mood
claims into this path. It has its own single controller-resolved boolean:

- a positive Shortlist `usedMusicalLeanings` decision may retain a natural
  track-specific reason;
- there is no free-text tie-break trait;
- the Debug `LEANINGS` badge follows that boolean alone.

The latter point matters: Debug temporarily required a non-empty
`leaningsTieBreak` as well as the boolean. Since the trait is intentionally
`null` on Shortlist, that hid all valid badges even though the model was
returning positive selections. The local Debug fix restores badge display from
the resolved boolean only.

Recent live Shortlist records confirmed positive model decisions, including
The Duke Spirit, Smerz and Korn, once the badge condition was corrected.

## Soul-only result

Do not claim that vanilla Soul prose has a proven picking effect on either
route. The calibrated experiment recorded in
`2026-09-19-agentic-soul.md` found equal Track Shortlist A/A and Soul A/B
change rates (9/24 each) on the local model and fixture. Early 6/12 Shortlist
observations were uncalibrated and are not causal evidence.

Soul remains available to the normal Agentic persona prompt; the result only
means its independent musical effect is not measurable enough for a badge.

## Suggested follow-up investigations

1. **Controller-verifiable preference annotations.** Map explicitly selected,
   controlled preferences (for example an exact configured genre lean) to
   candidate library metadata. Report a factual candidate match, never that it
   caused the selection. Do not use show mood/energy tags as Leanings evidence.
2. **Continue fixed-candidate controls.** The replay harness can compare the
   same candidate set with and without Leanings at aggregate scale. This is
   appropriate for evaluation, not live shadow decisions.
3. **Evaluate provenance separately.** A stronger model or a separately
   constrained evaluator may be able to provide grounded provenance, but it
   must be tested against copied-schema and generic-flow failures before any
   live badge is restored.
4. **Consider structured Leanings alongside prose.** A future operator-facing
   preference taxonomy could make factual matching auditable while retaining
   free text for broad taste.
5. **Debug quality.** Populate verified selection on the
   `djAgentEditorialPick` record as well as the original `djAgentPick` record;
   today the original card is refreshed to the final queued track, while the
   raw responses remain intentionally historical.

## Review / PR hand-off

PRs:

- #1678: `feat/musical-leanings` — shared policy, guest safe-off, Agentic
  implementation, Agentic replay harness, and this handover.
- #1687: `feat/intelligent-candidate-pool-alternative` — Track Shortlist
  behaviour, natural reason restoration, and the Shortlist Debug badge fix.

Before updating #1678, keep it independent of #1687: the Agentic editorial
selection currently reuses small prompt/schema helpers from
`music/dj-pick.ts`. Move or duplicate those generic helpers under the Agentic
module before cherry-picking, so #1678 can still merge ahead of #1687.

Suggested reviewer note:

> Agentic picking no longer exposes the Musical Leanings badge or tie-break
> diagnostic: local-model testing showed that model-reported provenance was
> unreliable. Musical Leanings remain required for Track Shortlist, where they
> provide the candidate-adjacent editorial cue that picker depends on.
>
> For Agentic picking, the vanilla discovery behaviour is unchanged. When a
> presenter has Musical Leanings configured, the discovered candidates receive
> one additional constrained editorial selection pass; this softly re-orders
> eligible choices without changing discovery, show rules, rotation, safety,
> or musical-flow constraints. With Leanings blank, Agentic follows its
> existing single-pass behaviour.
