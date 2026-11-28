import { VOICE_KINDS, DEDUPE_KINDS } from './queue/kinds.js';
import { stripClockPhrases } from './clock-phrases.js';

// Pure selection policy for the speech memory injected into DJ prompts. The
// booth log is station-wide; editorial continuity belongs to the current
// session, whose turns are stamped only after speech reaches air.

export interface PromptMemoryTurn {
  t: string;
  role: string;
  kind: string;
  text: string;
  meta?: { personaId?: string; personaName?: string; verbatim?: boolean; [k: string]: unknown };
}

// Words the station aired that no model wrote (#1908): a RAW POST /dj/say (the
// admin Say box, MCP's subwave_dj_announce and Connect agents all reach it) and
// a jingle's own script, which the on-demand play exists to air as an
// announcement. The turn still lands in the session, so the booth, GET /session
// and the booth carry show it, and djLog keeps its line; no prompt reads it.
// Negative context is still context: listed under "already said, do not
// repeat", an operator's emergency notice became the next banter's topic. The
// session's two prompt readers, promptMemoryEntries() below and
// session.windowMessages(), both ask withheldFromPrompts().
export const VERBATIM_META = { verbatim: true } as const;

export function withheldFromPrompts(turn: { meta?: { verbatim?: unknown } | null } | null | undefined): boolean {
  return turn?.meta?.verbatim === true;
}

// A mid-show host change (session.refreshHost: the operator moved the live
// show to another persona) keeps the editorial session, so the lines the
// previous host aired stay in it. Offered to the new host they read as a
// guest's words at best and as the station's voice at worst: the previous
// host's greeting naming the show before ("Tom Avro") sat in a new host's
// "You said these things on-air recently" block, every ident by the new host
// then aired "with Tom Avro", and each one fed the next prompt as his own
// words. So the change is a prompt-memory boundary for spoken lines, the way a
// show handoff is: before the LATEST change, a line attributed to anyone but
// the current host (`meta.personaId`, which every automatic host path stamps)
// is withheld, so an A -> B -> A change keeps A's first lines and never B's.
// An unattributed line (a legacy turn, a caller that stamps no speaker) stays,
// as before: nothing says whose it was, and a recovered session's memory must
// not empty itself on a host repair. Should such a line name the previous
// host, the spoken-line guard (util/host-name-policy.ts) still keeps that
// name off the air.
// The turns stay in session.json, the booth and djLog; only prompts lose them.
// The change is the scenario turn refreshHost() writes, stamped
// `meta.hostChange`; a session persisted before the stamp is recognised by
// that turn's fixed wording. Both prompt readers, promptMemoryEntries() and
// session.windowMessages(), ask heldByHostChange().
export const HOST_CHANGE_META = 'hostChange';
const LEGACY_HOST_CHANGE = /^Host changed from .+ to .+ while the show continues\.$/;

function isHostChange(turn: { role?: unknown; kind?: unknown; text?: unknown; meta?: Record<string, unknown> | null } | null | undefined): boolean {
  if (turn?.role !== 'event' || turn?.kind !== 'scenario') return false;
  return turn.meta?.[HOST_CHANGE_META] === true
    || (typeof turn.text === 'string' && LEGACY_HOST_CHANGE.test(turn.text));
}

// Whether the turn at `index` of `turns` is held from prompts by a later host
// change. `personaId` is the session's current host.
export function heldByHostChange(
  turns: readonly ({ role?: unknown; kind?: unknown; text?: unknown; meta?: Record<string, unknown> | null } | null | undefined)[],
  personaId: string | null,
): (index: number) => boolean {
  let last = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isHostChange(turns[i])) { last = i; break; }
  }
  if (last < 0) return () => false;
  return (index) => {
    if (index >= last) return false;
    const turn = turns[index];
    if (turn?.role !== 'segment') return false;
    const speakerId = turn.meta?.personaId;
    return typeof speakerId === 'string' && speakerId !== '' && speakerId !== personaId;
  };
}

export interface PromptMemoryEntry {
  t: string;
  kind: string;
  message: string;
}

// `personaId` is the session's OWN persona. A foreign speaker is either the
// mic-pass sign-off or a guest co-host, treated differently below.
export function promptMemoryEntries(
  turns: readonly PromptMemoryTurn[],
  personaId: string | null = null,
): PromptMemoryEntry[] {
  const out: PromptMemoryEntry[] = [];
  const held = heldByHostChange(turns, personaId);
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn?.role !== 'segment') continue;
    if (withheldFromPrompts(turn)) continue;
    if (held(i)) continue;
    // recover() validates the array but not each turn, and getDjRecap() runs
    // synchronously inside request/DJ routes: a hand-edited state file must
    // not turn into a 500.
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    const speakerId = turn.meta?.personaId;
    const foreign = Boolean(speakerId) && speakerId !== personaId;
    // The sign-off is the OUTGOING DJ's last line but lands in the session that
    // just started, so feeding it back is the cross-show bridge #1479 closes.
    // It stays in djLog and windowMessages(), which name its real speaker.
    if (foreign && turn.kind === 'handoff') continue;
    // Everything else foreign is a guest co-host. Carry the attribution so the
    // recap doesn't hand the host a guest's words as their own.
    const speaker = foreign ? (turn.meta?.personaName || 'another host') : null;
    out.push({ t: turn.t, kind: turn.kind, message: speaker ? `${speaker}: ${text}` : text });
  }
  return out.reverse();
}

// Shared recap policy. Callers supply the live DJ behaviour values; rendering
// can differ, but line count, lookback, kinds, dedupe and truncation cannot.
export function promptRecapEntries(
  entries: readonly PromptMemoryEntry[],
  { limit, withinMinutes, maxChars }: { limit: number; withinMinutes: number; maxChars: number },
  now = Date.now(),
): PromptMemoryEntry[] {
  if (limit <= 0 || withinMinutes < 0 || maxChars < 1) return [];
  const cutoff = now - withinMinutes * 60_000;
  const kinds = new Set<string>();
  const picked: PromptMemoryEntry[] = [];
  for (const entry of entries) {
    if (!VOICE_KINDS.has(entry.kind)) continue;
    const at = Date.parse(entry.t);
    if (!Number.isFinite(at) || at > now) continue;
    if (at < cutoff) break;
    if (DEDUPE_KINDS.has(entry.kind)) {
      if (kinds.has(entry.kind)) continue;
      kinds.add(entry.kind);
    }
    // A stated clock in an aired line is stale by the next prompt, and small
    // models copy it word for word (M1: "just after ten" airing at 11:48).
    // The recap exists to prevent repetition, so it never needs the time.
    const message = typeof entry.message === 'string'
      ? stripClockPhrases(entry.message.replace(/\s+/g, ' ').trim())
      : '';
    if (!message) continue;
    picked.push({ ...entry, message: message.length > maxChars ? message.slice(0, maxChars - 1) + '…' : message });
    if (picked.length >= limit) break;
  }
  return picked;
}
