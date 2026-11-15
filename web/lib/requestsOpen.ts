import type { StationState } from './types';

const FALLBACK = 'Requests are closed right now.';

/** The line a player shows in place of its request form, or null while
 *  requests are open. Only an explicit `open: false` closes: an older
 *  controller publishes nothing, and its POST /request still answers for
 *  itself. Decided by the controller (util/requests-open.ts). */
export function requestsClosedMessage(state: Pick<StationState, 'requests'> | null | undefined): string | null {
  const r = state?.requests;
  if (!r || r.open !== false) return null;
  return typeof r.message === 'string' && r.message.trim() ? r.message.trim() : FALLBACK;
}
