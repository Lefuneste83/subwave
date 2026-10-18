'use client';

// B10 — orphan stem dirs: what the cache holds for tracks that left the
// library, and the two presses about it. A dry-run report is the default read
// (GET never moves anything); "Move N to quarantine" confirms once; aged
// quarantines delete themselves after a week, and a track id that walks back
// into the library gets its dirs released rather than re-separated.
// The daily cron behind the toggle is off by default — deleting operator
// files is opt-in, and a first pass should be read, not trusted (#1570 rule).

import { useAdminAuth } from '../../lib/adminAuth';
import { useAdminMutation, useAdminQuery } from '../../lib/admin-query';
import type { AdminFetch } from '../../lib/admin-query';
import { Card, Btn, Pill } from './ui';

export interface OrphanReport {
  dryRun: boolean;
  keptCount: number;
  quarantined: number;
  quarantinedNames: string[];
  released: string[];
  deletedCount: number;
  deletedNames: string[];
  agingCount: number;
  supersededCount: number;
  inFlight: number;
  failed: number;
  refused?: boolean;
  reason?: string;
  freedBytes: number;
  offline?: string;
}

interface OrphanState {
  enabled: boolean;
  report: OrphanReport;
}

interface OrphanPayload {
  enabled: boolean;
  report: OrphanReport;
}

const orphanKeys = { all: ['stems', 'orphans'] as const, state: () => [...orphanKeys.all, 'state'] };

function useOrphanState(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<OrphanState>({
    key: orphanKeys.state(),
    adminFetch,
    enabled,
    request: (fetch, signal) =>
      fetch('/stems/orphans', { signal }).then(r => r.json() as Promise<OrphanState>),
  });
}

function useOrphanMutation(adminFetch: AdminFetch) {
  return useAdminMutation<OrphanPayload, { confirm?: boolean; setEnabled?: boolean }>({
    adminFetch,
    request: (vars, fetch) =>
      fetch('/stems/orphans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      }).then(r => {
        if (!r.ok) throw new Error(`purge failed (${r.status})`);
        return r.json() as Promise<OrphanPayload>;
      }),
  });
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export default function OrphanStemsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const ready = hydrated && !needsAuth;
  const stateQuery = useOrphanState(adminFetch, ready);
  const mutation = useOrphanMutation(adminFetch);
  const report = stateQuery.data?.report;
  const enabled = stateQuery.data?.enabled === true;

  const act = (vars: { confirm?: boolean; setEnabled?: boolean }) =>
    mutation.mutate(vars, { onSuccess: () => { void stateQuery.refetch(); } });

  return (
    <Card
      title="Orphan stem cleanup"
      sub="A track that leaves the library keeps its Demucs stem dirs until the byte budget evicts them. This finds those dirs, parks them in a quarantine for a week (a track that walks back gets them released, not re-separated), and deletes what ages out."
    >
      {!ready || stateQuery.isLoading ? (
        <p className="text-sm text-muted">Reading the cache…</p>
      ) : report?.refused ? (
        <p className="text-sm text-muted">
          <Pill tone="accent">refused</Pill>{' '}
          {report.offline ?? report.reason ?? 'the stems share is not readable'} — nothing was moved.
        </p>
      ) : report ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {report.quarantined > 0 ? (
              <>
                <strong className="mono-num">{report.quarantined}</strong> orphan dir
                {report.quarantined === 1 ? '' : 's'} found
                {report.inFlight > 0 ? ` (${report.inFlight} still being written, skipped)` : ''}.
              </>
            ) : (
              <>No orphan stem dirs{report.inFlight > 0 ? ` (${report.inFlight} in-flight skipped)` : ''}.</>
            )}
            {report.agingCount > 0 && (
              <> <strong className="mono-num">{report.agingCount}</strong> already in quarantine, aging.</>
            )}
            {report.deletedCount > 0 && (
              <> Deleted <strong className="mono-num">{report.deletedCount}</strong> aged quarantine
                ({mb(report.freedBytes)} freed).</>
            )}
            {report.released.length > 0 && (
              <> Released <strong className="mono-num">{report.released.length}</strong> back to the library.</>
            )}
            {report.failed > 0 && (
              <> <strong className="mono-num">{report.failed}</strong> failed — check ownership/permissions on the stems share.</>
            )}
          </p>
          {report.quarantinedNames.length > 0 && (
            <p className="mono-num text-[12px] break-all text-muted">
              {report.quarantinedNames.join(', ')}
              {report.quarantined > report.quarantinedNames.length ? ' …' : ''}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Btn
              sm
              tone="solid"
              disabled={report.quarantined === 0 || mutation.isPending}
              onClick={() => act({ confirm: true })}
            >
              {mutation.isPending ? 'Working…'
                : report.quarantined > 0 ? `Move ${report.quarantined} to quarantine` : 'Nothing to move'}
            </Btn>
            <Btn sm disabled={mutation.isPending} onClick={() => { void stateQuery.refetch(); }}>
              Re-scan
            </Btn>
            <Btn
              sm
              disabled={mutation.isPending}
              onClick={() => act({ setEnabled: !enabled })}
              title="The daily pass only quarantines; a quarantine is only deleted once it has aged a week."
            >
              Daily pass: {enabled ? 'on' : 'off'}
            </Btn>
          </div>
          <p className="text-[12px] text-muted">
            Quarantine holds each orphan for 7 days under <code>.orphan-quarantine</code> at the cache
            root — a move, not a copy, and invisible to every walk. This report is a dry run: nothing
            moved until you press it or the daily pass runs (off by default).
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">The stems share could not be read.</p>
      )}
    </Card>
  );
}
