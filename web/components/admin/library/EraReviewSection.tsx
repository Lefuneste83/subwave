'use client';

// Era review (C13): the albums the walk refuses to trust the release year of,
// per-album, with the reason that fired and the operator's override. Trust an
// album and its year is taken at face value again; Suspect an album the
// detector missed; Reset hands it back to the walk. The CSV is the same
// listing as a spreadsheet, for reviewing the tail offline.
import { useMemo, useState } from 'react';
import { Download, CalendarClock } from 'lucide-react';
import { adminJson, adminResponse } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { Btn, Pill } from '../ui';
import { Input } from '../../ui/input';
import { libraryKeys } from './queries';
import { useLibrary } from './LibraryContext';
import { useAdminMutation, useAdminQuery } from './useAdminQuery';

export interface EraAlbum {
  albumKey: string;
  album: string | null;
  albumArtist: string | null;
  reason: string | null;
  tracks: number;
  yearResolved: number;
  yearNotFound: number;
  yearUnchecked: number;
  year: number | null;
  overridden: boolean;
}

export interface EraSummary {
  albums: number;
  tracks: number;
  byReason: Record<string, number>;
  overridden: number;
}

interface EraResponse { albums: EraAlbum[]; summary: EraSummary }
interface OverrideResponse { ok: boolean; affected: number }

const NO_ALBUMS: EraAlbum[] = [];
const NO_SUMMARY: EraSummary = { albums: 0, tracks: 0, byReason: {}, overridden: 0 };

// The detector's markers, in the operator's words. Keyed by the server's
// reason codes (music/era-suspect.ts) so a new marker reads as its raw code
// rather than vanishing from the table.
const REASON_LABEL: Record<string, string> = {
  'compilation-flag': 'compilation flag',
  'various-artists': 'various artists',
  'many-artists': 'many artists',
  'title-year-range': 'year range in title',
  'title-compilation': 'says compilation',
};

const yearTally = (a: EraAlbum) =>
  `${a.yearResolved} resolved · ${a.yearNotFound} not found · ${a.yearUnchecked} unchecked`;

export default function EraReviewSection() {
  const { adminFetch } = useLibrary();
  const [filter, setFilter] = useState('');
  // The album key whose override request is in flight; others stay clickable.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const data = useAdminQuery<EraResponse>({
    key: libraryKeys.era(),
    path: '/library/era',
    toastOnError: true,
  });

  const override = useAdminMutation<OverrideResponse, { album: string; albumArtist: string | null; verdict: 'trusted' | 'suspect' | null }>({
    request: (vars, fetcher) =>
      adminJson<OverrideResponse>(fetcher, '/library/era/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      }),
    onDone: async (out, vars, qc) => {
      notify.ok(
        vars.verdict === null
          ? 'Override removed — the next library scan decides again'
          : `Saved as soon as you clicked: ${out.affected} track${out.affected === 1 ? '' : 's'} now ${vars.verdict}`,
      );
      // The override flips era_untrusted on every row of the album, and era
      // is read by the browse filters and coverage tallies too.
      await Promise.all([
        qc.invalidateQueries({ queryKey: libraryKeys.era() }),
        qc.invalidateQueries({ queryKey: libraryKeys.rows }),
        qc.invalidateQueries({ queryKey: libraryKeys.coverage() }),
      ]);
    },
  });

  const post = (a: EraAlbum, verdict: 'trusted' | 'suspect' | null) => {
    if (override.isPending) return; // one save at a time; clicks are ignored while pending
    setBusyKey(a.albumKey);
    override.mutate(
      { album: a.album ?? '', albumArtist: a.albumArtist, verdict },
      { onSettled: () => setBusyKey(null) },
    );
  };

  const [downloading, setDownloading] = useState(false);
  const downloadCsv = async () => {
    setDownloading(true);
    try {
      // admin-query-imperative: era-csv-export
      const r = await adminResponse(adminFetch, '/library/era/csv');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'era-suspects.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.err(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };

  const summary = data.data?.summary ?? NO_SUMMARY;
  const albums = data.data?.albums ?? NO_ALBUMS;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? albums.filter(a => (a.album ?? '').toLowerCase().includes(q) || (a.albumArtist ?? '').toLowerCase().includes(q))
      : albums;
  }, [albums, filter]);

  return (
    <div className="grid gap-3 border border-ink bg-bg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-ink">
          <CalendarClock size={13} /> Era review
        </span>
        <Pill tone="ink">{summary.albums} album{summary.albums === 1 ? '' : 's'}</Pill>
        <Pill tone="ink">{summary.tracks} track{summary.tracks === 1 ? '' : 's'}</Pill>
        {summary.overridden > 0 && <Pill tone="accent">{summary.overridden} overridden</Pill>}
        {Object.entries(summary.byReason)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => (
            <Pill key={reason}>{REASON_LABEL[reason] ?? reason}: {n}</Pill>
          ))}
        <span className="ml-auto">
          <Btn sm onClick={downloadCsv} disabled={downloading} title="Every track on an era-suspect album, as CSV">
            <Download size={13} /> {downloading ? 'Preparing…' : 'Download CSV'}
          </Btn>
        </span>
      </div>

      <span className="caption !tracking-[0.04em] !normal-case">
        The station treats these albums&apos; release year as the reissue&apos;s date, not the
        recordings&apos;. Trust an album to take its year at face value; Suspect one the detector
        missed; Reset hands it back to the next library scan. Overrides save as soon as you click.
      </span>

      <Input
        className="h-7 w-full max-w-xs px-2 text-xs"
        placeholder="Filter by album or artist…"
        value={filter}
        aria-label="Filter era-suspect albums"
        onChange={e => setFilter(e.currentTarget.value)}
      />

      {data.isPending ? (
        <span className="caption">loading…</span>
      ) : shown.length === 0 ? (
        <span className="caption">No era-suspect albums. The walk flags compilations, various-artist
          releases and titles like &ldquo;Best of&rdquo; or &ldquo;Singles 1968-1974&rdquo;.</span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[12px]">
            <thead>
              <tr className="caption text-left">
                <th className="py-1 pr-3 font-bold">Album — artist</th>
                <th className="py-1 pr-3 font-bold">Reason</th>
                <th className="py-1 pr-3 font-bold">Tracks</th>
                <th className="py-1 pr-3 font-bold">Year lookups</th>
                <th className="py-1 font-bold">Override</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(a => (
                <tr key={a.albumKey} className="border-t border-ink align-middle">
                  <td className="max-w-[280px] py-1.5 pr-3">
                    <span className="block truncate text-ink">{a.album ?? '(no album tag)'}</span>
                    <span className="caption block truncate">
                      {a.albumArtist ?? '(no album artist)'}{a.year != null ? ` · ${a.year}` : ''}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Pill tone={a.overridden ? 'accent' : 'ink'}>{a.reason ? (REASON_LABEL[a.reason] ?? a.reason) : 'operator'}</Pill>
                  </td>
                  <td className="mono-num py-1.5 pr-3">{a.tracks}</td>
                  <td className="caption py-1.5 pr-3 whitespace-nowrap">{yearTally(a)}</td>
                  <td className="py-1.5">
                    <span className="flex flex-wrap gap-1.5">
                      <Btn sm onClick={() => post(a, 'trusted')} disabled={override.isPending}
                        title="Treat this album's year as the recordings' year">Trust</Btn>
                      <Btn sm onClick={() => post(a, 'suspect')} disabled={override.isPending}
                        title="Keep treating the year as the reissue's, whatever the walk says">Suspect</Btn>
                      {a.overridden && (
                        <Btn sm onClick={() => post(a, null)} disabled={override.isPending}
                          title="Drop the override; the next library scan decides again">Reset</Btn>
                      )}
                      {busyKey === a.albumKey && <span className="caption self-center">saving…</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
