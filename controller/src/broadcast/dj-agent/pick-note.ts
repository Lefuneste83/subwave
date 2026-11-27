// Does a pick's note describe the track that was queued (#1978)? The rule is
// util/request-claim.ts's misnamedPickNote; this is the one place the three
// pick routes — Agentic, Track Shortlist and the pool — hand it the names a
// note may say without claiming a track, so every queue and settings read
// stays here and the routes cannot drift apart.
//
// Never a model call. A note is read in the Booth and by the next pick, never
// aired, so a misnamed one is replaced by the route's own plain copy and the
// track stands — it passed every guard, and only the words were wrong. The
// spoken link needs no check of this kind: it is written after the final
// choice by a separate call that is handed only the queued track, never the
// pick's note, search or candidates.

import * as settings from '../../settings.js';
import { logEvent } from '../../observability/events.js';
import { onAirPersona } from '../session.js';
import { pickNoteLanguage, type PickNoteLanguage } from './pick-reason-language.js';
import { misnamedPickNote, type ClaimTrack } from '../../util/request-claim.js';
import { scriptLeakVerdict } from '../../util/script-leak-policy.js';

type Named = { title?: string | null; artist?: string | null } | null | undefined;

// The language a pick made now writes its note in: the on-air persona's, the
// one pickSystem's own prompt is voiced by (session.onAirPersona, which the
// pick's look-ahead has already rolled). The rule is pick-reason-language.ts;
// the session read stays here with the routes' other reads, since the policy
// module sits under the session in the import graph.
export function onAirPickNoteLanguage(): PickNoteLanguage {
  return pickNoteLanguage(onAirPersona());
}

// The station's own names: whoever voices the line, the roster's host and
// guests, the station itself. Shared with the request claim guard (#1918).
export function stationClaimNames(voice: { name?: string | null } | null | undefined, at?: Date): Array<string | null | undefined> {
  const roster = settings.getOnAirRoster(at);
  return [voice?.name, roster.host?.name, ...roster.guests.map((g: any) => g?.name), settings.get().station];
}

// What a pick model is handed as context rather than to choose from: the
// track it follows (the pick event names it, and the one before), what is on
// air, queued and recently played, and the show's own name and brief. A note
// naming any of these ("after Porcelain's hush") is a reference.
function pickReferences(queue: any, pickAnchor: Named, show: any): Array<string | null | undefined> {
  const tracks: Named[] = [
    pickAnchor,
    queue?.current?.track,
    ...(Array.isArray(queue?.upcoming) ? queue.upcoming.map((item: any) => item?.track) : []),
    ...(typeof queue?.getRecentTracks === 'function' ? queue.getRecentTracks() : []),
  ];
  return [...tracks.flatMap((t) => [t?.title, t?.artist]), show?.name, show?.topic];
}

// The same context names plus the show's genres, for the Agentic route's
// capitalised-name read (leanings-review.ts agenticDiscoverySelectionReason):
// a note calling the pick "Regional Indian" is naming the lane, not a record.
export function pickNoteReferences(queue: any, pickAnchor: Named, show: any): Array<string | null | undefined> {
  return [...pickReferences(queue, pickAnchor, show), ...(Array.isArray(show?.genres) ? show.genres : [])];
}

// The note as the route may show it: unchanged, or '' — the route's own
// plain-copy signal — when it names another candidate or a quoted title over
// the queued track.
export function groundPickNote(queue: any, note: string | null | undefined, { track, candidates, pickAnchor = null, show = null, route }: {
  track: ClaimTrack & { id?: unknown };
  candidates: Iterable<(ClaimTrack & { id?: unknown }) | null | undefined>;
  pickAnchor?: Named;
  show?: any;
  route: 'pick' | 'shortlist' | 'pool';
}): string {
  const text = typeof note === 'string' ? note : '';
  if (!text.trim()) return text;
  const pool = [...candidates];
  const cleaned = pickNoteWithoutScriptLeak(queue, text, { track, candidates: pool, pickAnchor, show, route });
  if (!cleaned) return '';
  if (cleaned !== text) return groundPickNote(queue, cleaned, { track, candidates: pool, pickAnchor, show, route });
  const others = pool.filter((c) => c && c.id !== track.id);
  const claims = misnamedPickNote(text, {
    track,
    others,
    stationNames: stationClaimNames(null),
    references: pickReferences(queue, pickAnchor, show),
  });
  if (!claims.length) return text;
  const named = [...new Set(claims.map((c) => `"${c.text}"`))].join(', ');
  // Optional: the benches hand the pool a stub queue.
  queue?.log?.(route === 'shortlist' ? 'shortlist' : 'picker',
    `${route} note named ${named} over "${track.title}" by ${track.artist} — replaced with plain copy`);
  logEvent('pick.misnamed', {
    agent: route, to: track.id ?? null, lines: [{ field: 'reason', claims }], candidates: others.length, outcome: 'note-plain',
  });
  return '';
}

// A pick note with a word from a writing system the on-air persona's language
// does not use (util/script-leak-policy.ts, the `note` surface). Look-alike
// letters inside a word are mended in place (`fold`), never cut. A note is read
// in the Booth, never aired, so this is minor and never retried: the foreign
// runs come out and the rest of the note stays. Returns the note unchanged,
// that cleaned note, or '' (the routes' plain-copy signal, “Title” — Artist
// in any language but English) when too little is left to mean anything. The
// names it may carry in another script are the queued track's, the other
// candidates', the pick's context and the station's own. Logged once, with the
// offending letters.
export function pickNoteWithoutScriptLeak(queue: any, note: string | null | undefined, { track, candidates = [], pickAnchor = null, show = null, route }: {
  track: (ClaimTrack & { id?: unknown; album?: unknown; genre?: unknown; genres?: unknown }) | null | undefined;
  candidates?: Iterable<(ClaimTrack & { id?: unknown }) | null | undefined>;
  pickAnchor?: Named;
  show?: any;
  route: 'pick' | 'shortlist' | 'pool';
}): string {
  const text = typeof note === 'string' ? note : '';
  if (!text.trim()) return text;
  const languages = settings.personaLanguages(onAirPersona());
  const names: unknown[] = [
    track?.title, track?.artist, track?.album, track?.genre,
    ...(Array.isArray(track?.genres) ? track.genres : []),
    ...[...candidates].flatMap((c) => [c?.title, c?.artist]),
    ...pickNoteReferences(queue, pickAnchor, show),
    ...stationClaimNames(null),
  ];
  const verdict = scriptLeakVerdict(text, { languages, names, surface: 'note' });
  if (verdict.action === 'fold') {
    const folded = verdict.folds.map((f) => `${f.from}→${f.to}`);
    queue?.log?.(route === 'shortlist' ? 'shortlist' : 'picker', `${route} note had look-alike letters in a ${languages.primary} note over "${track?.title}" by ${track?.artist} — mended (${folded.map((f) => `"${f}"`).join(', ')})`);
    logEvent('pick.scriptLeak', { agent: route, to: track?.id ?? null, language: languages.primary, folded, outcome: 'folded' });
    return verdict.text;
  }
  if (verdict.action !== 'strip' && verdict.action !== 'plain') return text;
  const runs = verdict.leak.runs.map((r) => `"${r}"`).join(', ');
  queue?.log?.(route === 'shortlist' ? 'shortlist' : 'picker', verdict.action === 'strip'
    ? `${route} note carried another writing system (${runs}) in a ${languages.primary} note over "${track?.title}" by ${track?.artist} — removed it, kept the rest`
    : `${route} note carried another writing system (${runs}) in a ${languages.primary} note over "${track?.title}" by ${track?.artist} — too little left, replaced with plain copy`);
  logEvent('pick.scriptLeak', {
    agent: route, to: track?.id ?? null, language: languages.primary, runs: verdict.leak.runs, scripts: verdict.leak.scripts,
    outcome: verdict.action === 'strip' ? 'note-stripped' : 'note-plain',
    ...(verdict.folds.length ? { folded: verdict.folds.map((f) => `${f.from}→${f.to}`) } : {}),
  });
  return verdict.action === 'strip' ? verdict.text : '';
}
