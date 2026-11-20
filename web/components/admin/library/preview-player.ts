'use client';

// The admin's preview player (G23): one audio element for the whole admin, so
// starting a track stops the one before it. A Library row's play button and its
// progress bar read this store; nothing here touches the live stream. The
// element plays a short-lived signed link the controller hands an admin
// (POST /library/:id/preview), because an <audio> element cannot send the
// console's Basic header; the link streams the original file with Range, so the
// bar seeks on real bytes. A link that lapsed while paused (6 h) fails on the
// next read: the row shows the error and the next press asks for a fresh one.

import { useEffect, useSyncExternalStore } from 'react';

export type PreviewStatus = 'loading' | 'playing' | 'paused' | 'error';

export interface PreviewSnapshot {
  id: string | null;
  status: PreviewStatus | null;
  time: number;      // seconds
  duration: number;  // seconds; 0 until the element knows
}

// The slice of HTMLAudioElement the store drives, so a test can stand one in.
export interface PreviewAudio {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, fn: () => void): void;
}

const IDLE: PreviewSnapshot = { id: null, status: null, time: 0, duration: 0 };

export function createPreviewPlayer(makeAudio: () => PreviewAudio) {
  let audio: PreviewAudio | null = null;
  let snap: PreviewSnapshot = IDLE;
  // Bumped by every start and stop, so a link that arrives after the operator
  // moved on is dropped instead of starting the wrong track.
  let generation = 0;
  const listeners = new Set<() => void>();

  const publish = (next: Partial<PreviewSnapshot>) => {
    const merged = { ...snap, ...next };
    if (merged.id === snap.id && merged.status === snap.status && merged.time === snap.time && merged.duration === snap.duration) return;
    snap = merged;
    for (const l of listeners) l();
  };
  const knownDuration = (a: PreviewAudio) => (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0);

  function element(): PreviewAudio {
    if (audio) return audio;
    const a = makeAudio();
    a.addEventListener('timeupdate', () => { if (snap.id) publish({ time: a.currentTime }); });
    a.addEventListener('durationchange', () => { if (snap.id) publish({ duration: knownDuration(a) }); });
    a.addEventListener('loadedmetadata', () => { if (snap.id) publish({ duration: knownDuration(a) }); });
    a.addEventListener('playing', () => { if (snap.id) publish({ status: 'playing' }); });
    a.addEventListener('pause', () => { if (snap.id && snap.status === 'playing') publish({ status: 'paused' }); });
    a.addEventListener('ended', () => { stop(); });
    a.addEventListener('error', () => { if (snap.id && a.src) publish({ status: 'error' }); });
    audio = a;
    return a;
  }

  function stop() {
    generation++;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    publish(IDLE);
  }

  // Play `id`, or pause/resume it when it is already the preview. `link` asks
  // the controller for the signed URL (only when a fresh one is needed).
  async function toggle(id: string, link: () => Promise<string>): Promise<void> {
    if (snap.id === id && snap.status === 'playing') {
      element().pause();
      return;
    }
    if (snap.id === id && snap.status === 'paused') {
      publish({ status: 'loading' });
      try {
        await element().play();
      } catch {
        if (snap.id === id) publish({ status: 'error' });
      }
      return;
    }
    if (snap.id === id && snap.status === 'loading') return;
    // A new track, or this one again after an error: a fresh link.
    stop();
    const mine = generation;
    publish({ id, status: 'loading', time: 0, duration: 0 });
    let url: string;
    try {
      url = await link();
    } catch {
      if (generation === mine) publish({ status: 'error' });
      return;
    }
    if (generation !== mine) return;
    const a = element();
    a.src = url;
    try {
      await a.play();
    } catch {
      if (generation === mine) publish({ status: 'error' });
    }
  }

  function seek(seconds: number) {
    if (!audio || !snap.id || !Number.isFinite(seconds)) return;
    const end = knownDuration(audio);
    const t = Math.max(0, end ? Math.min(seconds, end) : seconds);
    audio.currentTime = t;
    publish({ time: t });
  }

  return {
    toggle,
    seek,
    stop,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snap,
  };
}

export type PreviewPlayer = ReturnType<typeof createPreviewPlayer>;

let shared: PreviewPlayer | null = null;
function sharedPlayer(): PreviewPlayer {
  shared ??= createPreviewPlayer(() => {
    const a = new Audio();
    a.preload = 'auto';
    return a;
  });
  return shared;
}

// Tables currently showing rows: the preview stops when the last one unmounts,
// so it never plays on with no control on screen.
let mounted = 0;

export function usePreviewPlayer() {
  const player = typeof window === 'undefined' ? null : sharedPlayer();
  const snap = useSyncExternalStore(
    player ? player.subscribe : () => () => {},
    player ? player.getSnapshot : () => IDLE,
    () => IDLE,
  );
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (mounted === 0) shared?.stop();
    };
  }, []);
  return { snap, player };
}

export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
