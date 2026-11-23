import * as library from '../../music/library.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../util/pick-seed.js';

type PickAnchor = {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  bpm?: number | null;
  musicalKey?: string | null;
  energy?: string | null;
};

// Use the discovery candidates' field names and omit unknown facts. The
// predecessor is context only, so its id never enters this projection. In a
// DJ Hot Mix pick (`hotMix`) its tempo is the Hot Mix resolver's
// (library.mixTempoFor), so the model never reads one the window calls unknown.
export function predecessorContext(pickAnchor: PickAnchor | null, { hotMix = false }: { hotMix?: boolean } = {}) {
  if (!pickAnchor) return undefined;
  const rec = pickAnchor.id ? library.get(pickAnchor.id) : null;
  const bpm = hotMix ? library.mixTempoFor(pickAnchor) : (library.realBpm(rec?.bpm) ?? library.realBpm(pickAnchor.bpm));
  const key = rec?.musicalKey ?? pickAnchor.musicalKey ?? null;
  const energy = rec?.energy ?? pickAnchor.energy ?? null;
  if (bpm == null && key == null && energy == null) return undefined;
  return {
    title: pickAnchor.title,
    artist: pickAnchor.artist,
    ...(bpm != null ? { bpm } : {}),
    ...(key != null ? { key } : {}),
    ...(energy != null ? { energy } : {}),
  };
}

export function predecessorPrompt(context: ReturnType<typeof predecessorContext>): string {
  return context
    ? `\n\nPredecessor context: ${JSON.stringify(context)}. ${SEED_NOT_A_PICK_CLAUSE}`
    : '';
}
