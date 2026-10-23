// Era review (C13): the operator surface for era-suspect albums. The walk
// stores each track's era reason and album artist; this exposes the grouped
// listing the Library → Era tab reads, the per-album override that takes
// effect immediately (and again on every walk), and the CSV export.
// The judgement itself is music/era-suspect.ts; the storage is
// music/era-review.ts and library-db step 32.
import express from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import * as db from '../../music/library-db.js';
import {
  albumEraKey, countEraSummary, exportEraCsv, listEraAlbums, setEraOverride,
  type EraVerdict,
} from '../../music/era-review.js';

export const router = express.Router();

// A live handle or a 503: every era route reads the mirror, and a controller
// booting without a library answers the same way the other library reads do.
function handle(res: express.Response) {
  const d = db.getDb();
  if (!d) {
    res.status(503).json({ error: 'library database not open' });
    return null;
  }
  return d;
}

router.get('/library/era', requireAdmin, (_req, res) => {
  const d = handle(res);
  if (!d) return;
  try {
    res.json({ summary: countEraSummary(d), albums: listEraAlbums(d) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { album, albumArtist?, verdict: 'trusted' | 'suspect' | null }.
// The key is computed here, never taken from the client: one fold, one
// implementation (era-review.albumEraKey). `verdict: null` REMOVES the
// override; existing rows keep their current verdict until the next walk.
router.post('/library/era/override', requireAdmin, (req, res) => {
  const d = handle(res);
  if (!d) return;
  const { album, albumArtist, verdict } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof album !== 'string' || album.trim() === '') {
    return res.status(400).json({ error: 'album is required' });
  }
  if (albumArtist != null && typeof albumArtist !== 'string') {
    return res.status(400).json({ error: 'albumArtist must be a string when present' });
  }
  if (verdict !== null && verdict !== 'trusted' && verdict !== 'suspect') {
    return res.status(400).json({ error: "verdict must be 'trusted', 'suspect' or null" });
  }
  try {
    const affected = setEraOverride(d, albumEraKey(albumArtist as string | null | undefined, album), verdict as EraVerdict | null);
    res.json({ ok: true, affected });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// RFC4180 CSV of every track on an era-suspect album (same selection as the
// listing), as an attachment.
router.get('/library/era/csv', requireAdmin, (_req, res) => {
  const d = handle(res);
  if (!d) return;
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="era-suspects.csv"');
    res.send(exportEraCsv(d));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
