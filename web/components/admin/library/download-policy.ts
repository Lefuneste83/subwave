// The Library download button's rules (DownloadButton.tsx), pure so they are
// tested without a browser. One button in the Browse filter box: with rows
// ticked it takes those; with none, the whole list on screen (every page of
// the active filters and search). The controller side is
// controller/src/routes/library/download.ts.

import type { Energy, Sort, Vocal } from './types';

export interface BrowseFilterState {
  moods: string[]; energy: Energy; vocal: Vocal; genre: string;
  yearFrom: string; yearTo: string; q: string; sort: Sort;
}

// The Browse list's query parameters, paging aside. The list's own request
// and the download's `filter` are both built here, so "the whole list" is
// exactly the list the operator sees (the controller reads both with one
// parser, routes/library/browse.ts `browseFilterFromQuery`).
export function browseFilterParams(f: BrowseFilterState): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.moods.length) p.moods = f.moods.join(',');
  if (f.energy !== 'any') p.energy = f.energy;
  if (f.vocal !== 'any') p.vocal = f.vocal;
  if (f.genre) p.genre = f.genre;
  if (f.yearFrom) p.yearFrom = f.yearFrom;
  if (f.yearTo) p.yearTo = f.yearTo;
  if (f.q.trim()) p.q = f.q.trim();
  p.sort = f.sort;
  return p;
}

export type DownloadBody = { ids: string[] } | { filter: Record<string, string> };

export function downloadBody(selected: readonly string[], filter: BrowseFilterState): DownloadBody {
  return selected.length > 0 ? { ids: [...selected] } : { filter: browseFilterParams(filter) };
}

// How many tracks a press takes: the ticked ones, else the list's total (null
// until the list has answered).
export function downloadCount(selectedCount: number, listTotal: number | null): number | null {
  return selectedCount > 0 ? selectedCount : listTotal;
}

export function downloadLabel(count: number | null, pending: boolean): string {
  if (pending) return 'Preparing…';
  if (!count) return 'Download';
  return `Download ${count.toLocaleString('en-US')} track${count === 1 ? '' : 's'}`;
}

export function downloadTitle(selectedCount: number): string {
  return selectedCount > 0
    ? `Download the ${selectedCount} ticked track${selectedCount === 1 ? '' : 's'} (several come as one zip)`
    : 'Download every track in this list, all pages (several come as one zip); tick rows to take only those';
}

// What POST /library/download answers.
export interface DownloadLink {
  path: string;
  count: number;
  bytes: number;
  unsized: number;
  name: string;
  single: boolean;
  reindexing?: boolean;
}

// Above either, the operator confirms first: a slip on a big list would start
// hours of transfer.
export const CONFIRM_TRACKS = 50;
export const CONFIRM_BYTES = 2 * 1024 ** 3;

export function needsConfirm(link: Pick<DownloadLink, 'count' | 'bytes'>): boolean {
  return link.count > CONFIRM_TRACKS || link.bytes > CONFIRM_BYTES;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// The size the library walk recorded: an estimate, and some tracks have none.
export function sizeText(link: Pick<DownloadLink, 'count' | 'bytes' | 'unsized'>): string {
  if (link.unsized >= link.count || link.bytes <= 0) return 'size unknown';
  const est = `about ${fmtBytes(link.bytes)}`;
  return link.unsized > 0
    ? `${est}, plus ${link.unsized} track${link.unsized === 1 ? '' : 's'} of unknown size`
    : est;
}

export function confirmText(link: DownloadLink): string {
  const what = `${link.count.toLocaleString('en-US')} track${link.count === 1 ? '' : 's'}`;
  return `${what}, ${sizeText(link)}, as ${link.single ? 'one file' : `one zip (${link.name})`}. `
    + 'Your browser saves it as it arrives; the tracks come from the music server one at a time.';
}
