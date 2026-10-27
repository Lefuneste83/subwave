'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { adminJson, adminResponse, useAdminMutation, useAdminQuery, type AdminFetch } from '@/lib/admin-query';
import { notify } from '@/lib/notify';
import { ADMIN_API_URL } from '@/lib/adminAuth';
import { Label } from '../../ui/label';
import { Btn, Card } from '../ui';

// The station logo (controller branding/station-logo.ts): one square picture
// shown where a large one is missing — a track with no artwork, the lock
// screen and car display between songs — and published at /api/station-logo
// for directory listings (radio-browser.info's "favicon" field). The favicon
// and the small app icons keep the drawn mark: a detailed logo is unreadable
// at 16–64 px.

interface LogoView {
  set: boolean;
  mime: string | null;
  bytes: number;
  version: string | null;
  updatedAt: string | null;
}

const logoKey = ['settings', 'station-logo'] as const;
const TARGET_PX = 1024;
// The controller's cap is 2 MB; a PNG over this is re-encoded as WebP.
const PNG_BUDGET = 1.8 * 1024 * 1024;

// Fit (never crop) into a transparent TARGET_PX square, so a wide wordmark
// keeps its ends. PNG keeps transparency; a heavy one falls back to WebP,
// which keeps it too.
async function toSquareLogo(file: File): Promise<Blob> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) throw new Error('pick a PNG, JPEG or WebP image');
  if (file.size > 20 * 1024 * 1024) throw new Error('that image is over 20 MB');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_PX;
    canvas.height = TARGET_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser cannot resize images');
    const scale = Math.min(TARGET_PX / bitmap.width, TARGET_PX / bitmap.height);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, Math.round((TARGET_PX - w) / 2), Math.round((TARGET_PX - h) / 2), w, h);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode the image'))), type, quality));
    const png = await encode('image/png');
    return png.size <= PNG_BUDGET ? png : await encode('image/webp', 0.92);
  } finally {
    bitmap.close();
  }
}

export function StationLogoCard({ adminFetch }: { adminFetch: AdminFetch }) {
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const query = useAdminQuery<LogoView>({
    key: logoKey,
    adminFetch,
    request: (fetcher, signal) => adminJson<LogoView>(fetcher, '/settings/station-logo', undefined, signal),
    toastOnError: false,
  });

  const upload = useAdminMutation<LogoView, Blob>({
    adminFetch,
    request: async (blob, fetcher) => {
      const fd = new FormData();
      fd.append('file', blob, blob.type === 'image/webp' ? 'logo.webp' : 'logo.png');
      return adminJson<LogoView>(fetcher, '/settings/station-logo', { method: 'PUT', body: fd });
    },
    onDone: (view, _blob, client) => {
      client.setQueryData(logoKey, view);
      notify.ok('Saved: station logo');
    },
  });

  const remove = useAdminMutation<LogoView, void>({
    adminFetch,
    request: async (_v, fetcher) => {
      const res = await adminResponse(fetcher, '/settings/station-logo', { method: 'DELETE' });
      return (await res.json()) as LogoView;
    },
    onDone: (view, _v, client) => {
      client.setQueryData(logoKey, view);
      notify.ok('Removed: station logo');
    },
  });

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPreparing(true);
    try {
      upload.mutate(await toSquareLogo(file));
    } catch (err) {
      notify.err(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  };

  const view = query.data;
  const busy = preparing || upload.isPending || remove.isPending;
  const src = view?.set ? `${ADMIN_API_URL}/station-logo?v=${view.version}` : null;
  // Absolute, for pasting elsewhere; the API base is usually the relative
  // `/api`, so it is resolved against the page once mounted.
  const [publicUrl, setPublicUrl] = useState(`${ADMIN_API_URL}/station-logo`);
  useEffect(() => {
    setPublicUrl(new URL(`${ADMIN_API_URL}/station-logo`, window.location.origin).toString());
  }, []);

  return (
    <Card title="Station logo" sub="The picture for missing artwork, lock screens and radio directories">
      <div className="grid gap-[18px]">
        <div className="field">
          <Label>Logo</Label>
          <div className="flex flex-wrap items-end gap-4">
            {src ? (
              <>
                <img src={src} alt="Station logo" className="size-[128px] border border-line object-contain" />
                <img src={src} alt="" aria-hidden className="size-[40px] border border-line object-contain" />
              </>
            ) : (
              <div className="field-hint">
                {query.isPending ? 'Reading…' : 'No logo yet: missing artwork shows the music server’s own placeholder.'}
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onPick} />
            <Btn sm tone="accent" onClick={() => input.current?.click()} disabled={busy}>
              {preparing || upload.isPending ? 'Saving…' : view?.set ? 'Replace…' : 'Upload…'}
            </Btn>
            {view?.set && (
              <Btn sm onClick={() => remove.mutate()} disabled={busy}>Remove</Btn>
            )}
          </div>
          <div className="field-hint">
            A square image works best; anything else is fitted, never cropped, into a 1024 px square
            with a transparent border. The small preview is roughly how a lock screen or a radio app
            list shows it. Used for tracks without artwork, the lock screen and car display between
            songs, and directory listings. The browser tab icon and the home-screen icon keep the
            drawn SUB/WAVE mark, which stays readable at tiny sizes.
          </div>
        </div>

        <div className="field">
          <Label>Public address</Label>
          <code className="text-[12px] break-all">{publicUrl}</code>
          <div className="field-hint">
            Give this to radio-browser.info as the station&apos;s &ldquo;favicon&rdquo;: VLC, Sonos and
            most radio apps take a stream&apos;s logo from there, since the stream itself carries no
            picture. It always answers with a picture: the drawn mark until a logo is set.
          </div>
        </div>
      </div>
    </Card>
  );
}
