// Admin upload / removal of the station logo (branding/station-logo.ts). The
// public read is GET /station-logo in routes/public.ts.

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as stationLogo from '../branding/station-logo.js';
import { imageUpload } from '../middleware/upload.js';

export const router = express.Router();

function view(logo: stationLogo.StationLogo | null) {
  return logo
    ? { set: true, mime: logo.mime, bytes: logo.buf.length, version: logo.version, updatedAt: new Date(logo.mtimeMs).toISOString() }
    : { set: false, mime: null, bytes: 0, version: null, updatedAt: null };
}

router.get('/settings/station-logo', requireAdmin, async (_req, res) => {
  res.json(view(await stationLogo.read()));
});

// Multipart field `file`: the global JSON parser stops at 600 kB, too small
// for a 1024 px PNG with transparency.
router.put('/settings/station-logo', requireAdmin, imageUpload('file', stationLogo.MAX_LOGO_BYTES), async (req, res) => {
  try {
    res.json(view(await stationLogo.save((req as express.Request & { file?: { buffer: Buffer } }).file?.buffer)));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/settings/station-logo', requireAdmin, async (_req, res) => {
  await stationLogo.clear();
  res.json(view(null));
});
