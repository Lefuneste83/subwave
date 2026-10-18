// B10 — orphan stem-dir purge, operator surface.
//
// GET  /stems/orphans        dry-run report (never touches the disk)
// POST /stems/orphans        {confirm: true} runs the purge for real;
//                            {setEnabled: true|false} flips the daily cron.
//
// Manual triggers are exempt from every automatic gate (an explicit press
// always acts), but NOT from the purge's own safety rules: unconfirmed stays a
// dry run here too, and the empty-id-set / offline refusals are the module's,
// reported verbatim. requireAdmin, like every operator surface.

import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { allTrackIdsOrdered } from '../music/library-db.js';
import { runOrphanPurge } from '../music/orphan-purge.js';
import * as settings from '../settings.js';

export const router = Router();

router.get('/stems/orphans', requireAdmin, async (_req, res) => {
  try {
    const report = await runOrphanPurge({ knownIds: allTrackIdsOrdered(), confirm: false });
    res.json({ enabled: settings.get()?.audio?.stemOrphanPurgeEnabled === true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/stems/orphans', requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as { confirm?: unknown; setEnabled?: unknown };
  try {
    if (typeof body.setEnabled === 'boolean') {
      await settings.update({ audio: { stemOrphanPurgeEnabled: body.setEnabled } });
    }
    const confirm = body.confirm === true;
    const report = await runOrphanPurge({ knownIds: allTrackIdsOrdered(), confirm });
    res.json({ enabled: settings.get()?.audio?.stemOrphanPurgeEnabled === true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
