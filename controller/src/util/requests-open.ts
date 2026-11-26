// Whether listener requests are open right now, and the line a listener reads
// when they are not. One decision for both sides of it: POST /request refuses
// on it, and GET /state publishes it so every player can say so BEFORE a
// listener types a request (a refusal after the fact wastes their time).
//
// Closed when the station turned requests off (REQUESTS_DISABLED, or
// settings.requests.enabled false), or a DJ Hot Mix show that closes them is on
// air (music/hot-mix-policy.ts). The zero-listener pause is deliberately NOT
// here: it is about nobody listening, the page asking is often the first
// listener, and it lifts the moment they tune in, so publishing it would show a
// closed box to exactly the person about to open it.

import * as settings from '../settings.js';
import { REQUESTS_DISABLED } from '../middleware/ratelimit.js';
import { takesRequests } from '../music/hot-mix-policy.js';

export const REQUESTS_CLOSED_MESSAGE = 'Requests are temporarily closed.';

export type RequestsClosure =
  | { open: true }
  | { open: false; reason: 'station' | 'hot-mix'; message: string };

type ShowLike = { name?: unknown; hotMix?: unknown } | null | undefined;

export function requestsClosure(input: { disabledByEnv: boolean; stationEnabled: unknown; show: ShowLike }): RequestsClosure {
  if (input.disabledByEnv || input.stationEnabled === false) {
    return { open: false, reason: 'station', message: REQUESTS_CLOSED_MESSAGE };
  }
  if (!takesRequests(input.show)) {
    const name = typeof input.show?.name === 'string' && input.show.name.trim() ? input.show.name.trim() : 'This show';
    return { open: false, reason: 'hot-mix', message: `${name} is mixed live, track into track. Nothing is prerecorded, so requests are closed until the set ends.` };
  }
  return { open: true };
}

// Judged on the show on air now, the one a listener hears.
export function requestsClosureNow(): RequestsClosure {
  const s = settings.get() as { requests?: { enabled?: unknown } } | null;
  return requestsClosure({
    disabledByEnv: REQUESTS_DISABLED,
    stationEnabled: s?.requests?.enabled,
    show: settings.resolveActiveShow(),
  });
}
