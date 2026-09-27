// One editorial model call over a controller-built Track Shortlist.
//
// Discovery is deliberately absent here: candidates and factual provenance are
// supplied by music/shortlist.ts. The model chooses only from their ids and
// writes the listener-facing link/transition in the existing pick shape.

import { z } from 'zod';
import { djObject, modelTolerant } from '../llm/sdk.js';
import { pickSchemaBase, pickSystem, type EditorialLeaningsContext } from '../broadcast/dj-agent/schemas.js';
import type { ShortlistCandidate } from './shortlist.js';

export type ShortlistPick = {
  id: string;
  selectionReason: string;
  usedMusicalLeanings: boolean;
  leaningsTieBreak: string | null;
  say: string | null;
  transition: 'normal' | 'blend' | 'sweep' | 'washout' | 'dissolve' | 'chop' | 'loop' | null;
};

export type ShortlistSelectionContext = {
  currentTrack?: { id?: string | null; title?: string | null; artist?: string | null; album?: string | null } | null;
  precedingTrack?: { id?: string | null; title?: string | null; artist?: string | null; album?: string | null } | null;
  transition?: {
    recentChoices: string[];
    guidance: string;
  } | null;
  journey?: {
    direction: string;
    targetBpm?: number | null;
    targetKey?: string | null;
  } | null;
  curatedPlaylist?: {
    mode: 'soft' | 'strict';
  } | null;
  link?: string;
};

export function resolvedMusicalLeaningsFlag(
  context: EditorialLeaningsContext | null,
  modelFlag: unknown,
  _verifiedReason?: unknown,
): boolean {
  // Shortlist's controller-resolved declaration is deliberately a boolean.
  // Requiring a free-text trait made the local model re-label ordinary flow
  // facts as Leanings evidence.
  return !!context?.promptValue && modelFlag === true;
}

function comparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Library metadata commonly uses “feat.” while models naturally write
    // “featuring”. They identify the same credited artist list.
    .replace(/\bfeaturing\b/g, 'feat')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimDanglingEnding(value: string): string {
  return value
    .replace(/\s*[,;:]\s*(?:and|or|but)?\s*$/i, '')
    .replace(/\s+(?:and|or|but)\s*$/i, '')
    .trim();
}

// A model-written sentence is useful only when it identifies the very track
// that reached the queue. Corrective guards can replace the initial choice, so
// do this once at the final queue boundary rather than trusting a reason from a
// previous selection. A safe generic line is preferable to explaining Sam
// Smith with a Porcupine Tree note.
export function shortlistSelectionReason(track: any, reason: unknown): string {
  const trackTitle = typeof track?.title === 'string' ? track.title.trim() : '';
  const trackArtist = typeof track?.artist === 'string' ? track.artist.trim() : '';
  const title = comparable(trackTitle);
  const artist = comparable(trackArtist);
  const note = comparable(reason);
  if (note && (!title || note.includes(title)) && (!artist || note.includes(artist))) {
    return String(reason).trim();
  }

  // Small local models sometimes stop after naming the artist. Keep only a
  // clearly generic, artist-led fragment, trim a dangling conjunction, then
  // anchor it to the verified final title. This preserves useful variation
  // without allowing a corrected pick to inherit another track's explanation.
  const raw = typeof reason === 'string' ? trimDanglingEnding(reason.replace(/\s+/g, ' ')) : '';
  if (raw && trackTitle && trackArtist && artist && !note.includes(title)) {
    const remainder = raw.replace(new RegExp(`^${escapeRegExp(trackArtist)}\\s*[-—,:]?\\s*`, 'i'), '').trim();
    if (/^(?:fits|works|brings|keeps|matches|follows|continues|adds|carries|suits|makes|offers)\b/i.test(remainder)) {
      return `“${trackTitle}” by ${trackArtist} — ${/[.!?]$/.test(remainder) ? remainder : `${remainder}.`}`;
    }
  }

  const identity = [trackTitle, trackArtist].filter(Boolean).join(' by ');
  return identity ? `Selected "${identity}" from the eligible shortlist.` : 'Selected from the eligible shortlist.';
}

const LEANINGS_REFERENCE = /\b(?:musical\s+leanings?|broad\s+alternative\s+taste|(?:dj|host)(?:'s)?\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?)|(?:my|his|her|their)\s+(?:musical\s+)?(?:taste|tastes|preference|preferences)|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}['’]s\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?))\b/i;

// A verified note can still be too thin to be useful in the Booth. Keep a
// controller-written, track-specific floor without spending another model call.
export function usableSelectionReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  const note = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (note.length >= 24) return note;
  const artist = typeof song.artist === 'string' && song.artist.trim() ? song.artist.trim() : 'This artist';
  const title = typeof song.title === 'string' && song.title.trim() ? song.title.trim() : 'this track';
  return `${artist} — ${title}: selected for its fit with the current musical flow.`;
}

// Leanings are private selection context, not boilerplate for every Booth
// note. When the model did not explicitly mark them as material, remove a
// profile-parroting explanation rather than presenting it as normal fit.
export function shortlistReasonForLeanings(
  reason: unknown,
  usedMusicalLeanings: boolean,
  song: { artist?: unknown; title?: unknown },
): string {
  // The tie-break is a private diagnostic. Keep the model's track-specific
  // Booth reason intact when it was genuinely relevant; replacing it with a
  // terse trait discarded the useful editorial explanation.
  if (usedMusicalLeanings || !LEANINGS_REFERENCE.test(String(reason ?? ''))) {
    return usableSelectionReason(reason, song);
  }
  return usableSelectionReason('', song);
}

export function shortlistPickSchema(ids: string[]) {
  if (!ids.length) throw new Error('cannot select from an empty Track Shortlist');
  const idEnum = z.enum(ids as [string, ...string[]]).describe('the exact id of one track in the supplied Track Shortlist');
  return modelTolerant(pickSchemaBase().omit({ reason: true }).extend({
    id: idEnum,
    // Editorial only: provenance remains controller-written and must never be
    // reconstructed from the model's interpretation of the shortlist.
    selectionReason: z.string().trim().min(24).max(280).describe('private Booth Log selection note — never spoken on air. Name the selected artist and track title, then explain their musical fit in this moment. Do not introduce or announce the track, imply queue position, use first-person DJ framing, or say "next up", "coming up", "we are playing", or "we have". Never claim source names, source counts, or diagnostic facts.'),
    usedMusicalLeanings: z.boolean().optional().describe('private diagnostic flag. True only when supplied Musical Leanings materially settled this final choice among otherwise eligible shortlist tracks; otherwise false. If false, selectionReason must not mention, quote, paraphrase, or refer to the DJ’s Musical Leanings, preferences, or tastes. This must not change any on-air link.'),
  }), { objectFallbacks: { selectionReason: 'Selected for its fit with the current musical flow.' } });
}

export function shortlistPickPrompt(candidates: ShortlistCandidate[], context: ShortlistSelectionContext = {}, editorialLeanings: EditorialLeaningsContext | null = null): string {
  return JSON.stringify({ context: { ...context, musicalLeanings: editorialLeanings?.promptValue ?? null }, shortlist: candidates }, null, 2)
    + '\n\nChoose one id from this Track Shortlist. The controller has already applied the station guards. Use the current and preceding tracks to judge continuity. When transition context is supplied, set transition by what THIS moment needs and vary deliberately from its recent choices. When journey context is supplied, move one step toward its direction while maintaining the stated energy; never mention the journey on air. When curatedPlaylist.mode is "soft", strongly prefer candidates whose shortlistSources contain "showPlaylistTracks"; only step outside when the flow clearly calls for it. Write selectionReason as a private Booth Log note, never on-air DJ speech: name your selected artist and track title, then explain the musical fit. Do not introduce or announce the track, imply it is next in the queue, use first-person DJ framing, or say "next up", "coming up", "we are playing", or "we have". Do not name shortlist sources: the controller adds that factual hint. Use Musical Leanings, when supplied, as a soft editorial preference among already eligible tracks. They may inform the final choice without being decisive, but never override show rules, rotation, safety, or musical flow. Set usedMusicalLeanings to true when they materially informed this selection; otherwise false. Only when it is true may selectionReason naturally refer to the DJ’s preferences. When false, selectionReason must not quote, paraphrase, or refer to Musical Leanings, preferences, or tastes; describe the track’s fit only.';
}

export async function djPick({
  candidates,
  showAt = null,
  playlistResolved = true,
  context = {},
  editorialLeanings = null,
}: {
  candidates: ShortlistCandidate[];
  showAt?: Date | null;
  playlistResolved?: boolean;
  context?: ShortlistSelectionContext;
  editorialLeanings?: EditorialLeaningsContext | null;
}): Promise<ShortlistPick> {
  const ids = candidates.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  const shortlistResolution: any = {};
  const selection = await djObject({
    system: pickSystem(showAt, playlistResolved, true, editorialLeanings),
    prompt: shortlistPickPrompt(candidates, context, editorialLeanings),
    schema: shortlistPickSchema(ids),
    temperature: 0.5,
    kind: 'djShortlistPick',
    telemetry: { shortlistResolution },
  }) as ShortlistPick;
  const track = candidates.find((candidate) => candidate.id === selection.id);
  const rawSelectionReason = usableSelectionReason(shortlistSelectionReason(track, selection.selectionReason), track ?? {});
  const usedMusicalLeanings = resolvedMusicalLeaningsFlag(editorialLeanings, selection.usedMusicalLeanings);
  const leaningsTieBreak = null;
  const selectionReason = shortlistReasonForLeanings(rawSelectionReason, usedMusicalLeanings, track ?? {});
  shortlistResolution.track = {
    id: selection.id,
    title: track?.title ?? null,
    artist: track?.artist ?? null,
  };
  shortlistResolution.selectionReason = selectionReason;
  shortlistResolution.usedMusicalLeanings = usedMusicalLeanings;
  shortlistResolution.leaningsTieBreak = leaningsTieBreak;
  return {
    ...selection,
    selectionReason,
    usedMusicalLeanings,
    leaningsTieBreak,
  };
}
