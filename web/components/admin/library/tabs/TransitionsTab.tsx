'use client';

import { transitionReadinessResponseSchema, type TransitionReadiness } from '../../../../lib/schemas.generated';
import TransitionsView from '../TransitionsView';
import { libraryKeys } from '../queries';
import { useAdminQuery } from '../useAdminQuery';

// The controller counts in the background and answers with its last snapshot
// (null before the first), so the tab polls: quickly until the first count
// lands, then once a minute, which is as often as the controller recounts.
export default function TransitionsTab() {
  const q = useAdminQuery<TransitionReadiness | null>({
    key: libraryKeys.transitions(),
    path: '/library/transitions',
    toastOnError: true,
    refetchInterval: query => (query.state.data ? 60_000 : 3_000),
    parse: raw => {
      const r = transitionReadinessResponseSchema.safeParse(raw);
      if (!r.success) throw new Error('The controller sent transition counts this page cannot read.');
      return r.data.readiness;
    },
  });
  return <TransitionsView readiness={q.data ?? null} />;
}
