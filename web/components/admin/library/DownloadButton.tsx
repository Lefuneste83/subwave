'use client';

// The Library download: one button in the Browse filter box. With rows
// ticked it downloads those; with none, every track of the list on screen,
// all pages. One track saves as its original file, several as one zip that the
// controller builds as it streams. The POST answers a short-lived signed link
// and the browser navigates to it, so a many-GB body goes straight to disk
// instead of through fetch() into memory (the rules: download-policy.ts; the
// controller: routes/library/download.ts).

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Btn } from '../ui';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { ADMIN_API_URL } from '../../../lib/adminAuth';
import { adminJson, useAdminMutation } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import { useLibrary } from './LibraryContext';
import {
  confirmText, downloadBody, downloadCount, downloadLabel, downloadTitle, needsConfirm, sizeText,
  type BrowseFilterState, type DownloadBody, type DownloadLink,
} from './download-policy';

// The view, apart from the hooks, so its states render in a test.
export function DownloadControl({ count, selectedCount, pending, onClick }: {
  count: number | null;
  selectedCount: number;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Btn
      // The ticked rows drive it: shown in the accent, like any on state.
      tone={selectedCount > 0 ? 'accent' : undefined}
      onClick={onClick}
      disabled={pending || !count}
      title={downloadTitle(selectedCount)}
      className="h-10 w-full sm:w-auto"
    >
      <Download /> {downloadLabel(count, pending)}
    </Btn>
  );
}

// Starts the browser's own download of the signed link. The answer is an
// attachment, so the page stays where it is.
function startDownload(link: DownloadLink) {
  const a = document.createElement('a');
  a.href = `${ADMIN_API_URL}${link.path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  notify.ok(`download started · ${link.count} track${link.count === 1 ? '' : 's'}`
    + (link.single ? '' : ' in one zip') + ` · ${sizeText(link)}`);
}

export function DownloadButton({ filter, listTotal }: {
  filter: BrowseFilterState;
  listTotal: number | null;
}) {
  const { adminFetch, selected } = useLibrary();
  const [confirm, setConfirm] = useState<DownloadLink | null>(null);
  const mutation = useAdminMutation<DownloadLink, DownloadBody>({
    adminFetch,
    request: (body, fetcher) => adminJson<DownloadLink>(fetcher, '/library/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const count = downloadCount(selected.size, listTotal);

  const press = async () => {
    let link: DownloadLink;
    try {
      link = await mutation.mutateAsync(downloadBody(Array.from(selected), filter));
    } catch {
      return; // useAdminMutation has toasted it
    }
    if (needsConfirm(link)) setConfirm(link);
    else startDownload(link);
  };

  return (
    <>
      <DownloadControl count={count} selectedCount={selected.size} pending={mutation.isPending} onClick={press} />
      <V3AlertDialog
        open={confirm !== null}
        onOpenChange={open => { if (!open) setConfirm(null); }}
        title="Download"
        description={confirm ? confirmText(confirm) : ''}
        confirmLabel={confirm ? downloadLabel(confirm.count, false) : 'download'}
        onConfirm={() => { if (confirm) startDownload(confirm); }}
      />
    </>
  );
}
