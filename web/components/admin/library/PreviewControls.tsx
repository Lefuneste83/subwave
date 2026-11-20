'use client';

// The preview player's row controls (G23), shared by every Library list that
// shows a cover: the cover as the play button, and the bar under the playing
// row. The store behind them is preview-player.ts.

import { Play, Pause, Loader2, AlertTriangle, X } from 'lucide-react';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
import { useAdminAuth, ADMIN_API_URL } from '../../../lib/adminAuth';
import { adminJson } from '../../../lib/admin-query';
import { Thumb } from './bits';
import { fmtClock, usePreviewPlayer, type PreviewPlayer, type PreviewSnapshot } from './preview-player';
import type { Track } from './types';

// The shared player, and the signed link its <audio> element plays
// (routes/library/preview.ts).
export function usePreviewControls() {
  const { snap, player } = usePreviewPlayer();
  const { adminFetch } = useAdminAuth();
  const linkFor = (id: string) => async () => {
    const j = await adminJson<{ path: string }>(adminFetch, `/library/${encodeURIComponent(id)}/preview`, { method: 'POST' });
    return `${ADMIN_API_URL}${j.path}`;
  };
  return { snap, player, linkFor };
}

// The row's cover doubles as its play button: no extra column, so it fits a
// phone row as it is. Its icon shows on hover or focus, and stays while the
// track is the preview.
export function PreviewButton({ track, snap, onPress, active }: {
  track: Track;
  snap: PreviewSnapshot;
  onPress: () => void;
  // Which row owns the preview when a track can list twice (History): the
  // default is any row of this track.
  active?: boolean;
}) {
  const mine = active ?? snap.id === track.id;
  const status = mine ? snap.status : null;
  const name = track.title || 'track';
  const label = status === 'playing' ? `Pause ${name}` : status === 'loading' ? `Loading ${name}` : `Play ${name}`;
  return (
    <button
      type="button"
      className={cn('lib-play', mine && 'lib-play-on')}
      onClick={onPress}
      aria-label={label}
      title={status === 'error' ? 'Could not play this track. Press to try again.' : label}
      disabled={!track.id}
    >
      <Thumb track={track} />
      <span className="lib-play-icon" aria-hidden>
        {status === 'playing' ? <Pause size={18} />
          : status === 'loading' ? <Loader2 size={18} className="animate-spin" />
          : status === 'error' ? <AlertTriangle size={18} />
          : <Play size={18} />}
      </span>
    </button>
  );
}

// Under the row while its track is the preview: where it is, a bar to click or
// drag to seek, and how long it runs.
export function PreviewBar({ track, snap, player }: { track: Track; snap: PreviewSnapshot; player: PreviewPlayer }) {
  const duration = snap.duration || track.duration || 0;
  return (
    <div className="lib-preview">
      <span className="lib-preview-time">{fmtClock(snap.time)}</span>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(snap.time, duration || 1)}
        disabled={!duration}
        onChange={e => player.seek(Number(e.target.value))}
        aria-label={`Position in ${track.title || 'track'}`}
        aria-valuetext={`${fmtClock(snap.time)} of ${fmtClock(duration)}`}
        className="min-w-0 flex-1 accent-[var(--accent)]"
      />
      <span className="lib-preview-time">{snap.status === 'error' ? 'error' : fmtClock(duration)}</span>
      <Btn sm onClick={() => player.stop()} title="Stop the preview" aria-label="Stop the preview">
        <X size={12} />
      </Btn>
    </div>
  );
}
