// POST /library/download (routes/library/download.ts): what the admin Library's
// download button asks for. Exactly one of:
// - `ids`: the rows the operator ticked, in the order to pack them;
// - `filter`: the Browse list's own query-string parameters (minus paging), so
//   the server reads every page of exactly the list on screen.
import { z } from 'zod';

/** Ticked rows per request; a whole list goes as a `filter` instead. */
export const LIBRARY_DOWNLOAD_IDS_MAX = 10_000;

// Subsonic ids are short alphanumerics (the /cover/:id and preview rule).
const trackId = z.string().regex(/^[\w-]{1,64}$/, 'bad track id');
const param = (max: number) => z.string().max(max).optional();

export const libraryDownloadFilterSchema = z.object({
  moods: param(2_000),
  energy: param(32),
  genre: param(200),
  vocal: param(32),
  yearFrom: param(8),
  yearTo: param(8),
  q: param(2_000),
  sort: param(32),
});

export const libraryDownloadSchema = z.object({
  ids: z.array(trackId).min(1, 'ids must name at least one track')
    .max(LIBRARY_DOWNLOAD_IDS_MAX, `at most ${LIBRARY_DOWNLOAD_IDS_MAX} ticked tracks per download`)
    .optional(),
  filter: libraryDownloadFilterSchema.optional(),
}).refine(b => (b.ids === undefined) !== (b.filter === undefined), {
  message: 'send either ids or filter',
});

export type LibraryDownloadBody = z.infer<typeof libraryDownloadSchema>;
export type LibraryDownloadFilter = z.infer<typeof libraryDownloadFilterSchema>;
