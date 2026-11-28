// Where the off-air-presenter rule (util/host-name-policy.ts) is asked, with
// the station's live scene: every persona, who is on the air, and the names a
// line may carry. Both places that act ask through judgeHostNames(), so the
// free-text writer's one regeneration (llm djText `speaker`) and the speech
// gate's drop (queue.speakable, trimLinkToIntro) can never disagree about a
// line.
//
// The scene comes from the queue, which registers it when it is built: it
// owns the tracks and requesters a line may name, and it already reads the
// roster and the session. The llm layer imports only this module, never the
// queue. Before a queue exists (a test that loads a writer alone) nothing is
// judged: the rule fails open, as it does on any error reading the scene.

import { hostNameVerdict, type HostNameVerdict } from '../util/host-name-policy.js';

export interface HostNameScene {
  personas: readonly { id?: unknown; name?: unknown }[];
  /** Persona ids on the air now (roster host and guests, the session's host, the next presenter in the final quarter hour). */
  onAir: readonly unknown[];
  /** Names a line may carry that are not personas (tracks, requesters, the station, the weather place). */
  names: readonly unknown[];
}

let sceneProvider: (() => HostNameScene) | null = null;

export function setHostNameScene(provider: (() => HostNameScene) | null): void {
  sceneProvider = provider;
}

export function judgeHostNames(
  text: string,
  { speaker = null, kind = null, names = [], cast = [], retry = false }: {
    speaker?: { id?: unknown; name?: unknown } | null;
    kind?: string | null;
    names?: readonly unknown[];
    /** The other voices of the exchange this line belongs to. */
    cast?: readonly ({ id?: unknown } | null | undefined)[];
    retry?: boolean;
  } = {},
): HostNameVerdict {
  if (!text || !sceneProvider) return { action: 'keep' };
  let scene: HostNameScene;
  try {
    scene = sceneProvider();
  } catch {
    return { action: 'keep' };
  }
  return hostNameVerdict(text, {
    kind,
    speaker,
    personas: scene.personas,
    onAir: [...scene.onAir, ...cast.map(p => p?.id)],
    names: [...names, ...scene.names],
    retry,
  });
}
