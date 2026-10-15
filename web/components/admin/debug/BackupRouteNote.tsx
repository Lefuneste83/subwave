import type { DebugLlm } from './types';

type Routing = NonNullable<DebugLlm['routedToBackup']>;

const REASON: Record<string, string> = {
  unreachable: 'primary unreachable',
  exhausted: 'primary failing (5xx)',
  hung: 'primary not answering',
};

// The tooltip: why the primary was set aside and how long the window has left.
// The controller re-checks the window on every /debug read, so this only has to
// phrase it; `now` is a parameter so the wording can be tested.
export function backupRouteTitle(r: Routing, now: number = Date.now()): string {
  const why = (r.kind && REASON[r.kind]) || 'primary marked down';
  if (typeof r.until !== 'number') return `${why} — routing to the backup`;
  const mins = Math.max(1, Math.ceil((r.until - now) / 60_000));
  return `${why} — routing to the backup for about ${mins} more min, then the primary is tried again`;
}

// Inline note on the "LLM recent calls" subtitle while calls go to the backup
// (N2). The dot borrows the Dash "On Air" LIVE lamp's colour: the theme
// accent with its glow. Nothing renders under normal routing, so the subtitle
// returns to its plain form when the primary is back.
export default function BackupRouteNote({ routing }: { routing?: DebugLlm['routedToBackup'] }) {
  if (!routing) return null;
  const label = [routing.provider, routing.model].filter(Boolean).join(' / ') || 'backup';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={backupRouteTitle(routing)}>
      <span
        aria-hidden="true"
        className="inline-block size-[7px] shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_1px_color-mix(in_oklab,var(--accent)_70%,transparent)]"
      />
      <span>routed to backup {label}</span>
    </span>
  );
}
