// The station logo: one operator-uploaded square image, kept as
// `<stateDir>/branding/station-logo.<png|jpg|webp>` (its presence is the
// setting, so a per-station state dir gives each station its own, and the
// backup carries `branding/` whole). It is the station's
// picture wherever a LARGE one is missing:
//  - the cover of a track with no artwork (routes/public.ts /cover/:id, with
//    music/cover-fallback.ts deciding what "no artwork" looks like);
//  - lock screen / car / media-hub artwork when nothing else is on air;
//  - a stable public URL (GET /api/station-logo) for directory listings such
//    as radio-browser.info's "favicon" field, the only way a stream's logo
//    reaches VLC, Sonos and the radio apps (an Icecast stream carries none).
// It never replaces the favicon or the small app icons: a detailed logo turns
// to mush at 16–64 px, so those keep the drawn mark (web/lib/discMark.js).

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { extForMime, mimeForExt, sniffMime, type ImageMime } from '../util/image-mime.js';

const BASENAME = 'station-logo';
/** Hard cap on the DECODED image. The admin resizes to 1024 px before upload. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface StationLogo {
  buf: Buffer;
  mime: ImageMime;
  mtimeMs: number;
  /** Changes with every upload; for ETags and cache-busting query strings. */
  version: string;
}

function dir(): string {
  return `${config.stateDir}/branding`;
}

async function existingFiles(): Promise<string[]> {
  try {
    return (await readdir(dir())).filter(f => /^station-logo\.(png|jpg|webp)$/.test(f));
  } catch {
    return [];
  }
}

// Memoised on the file's mtime, so the cover route can ask per request
// without reading the image each time.
let memo: { file: string; mtimeMs: number; logo: StationLogo } | null = null;

/** The current logo, or null when none is set (or it cannot be read). */
export async function read(): Promise<StationLogo | null> {
  const files = await existingFiles();
  if (!files.length) {
    memo = null;
    return null;
  }
  const file = files.sort()[0];
  try {
    const st = await stat(`${dir()}/${file}`);
    if (memo && memo.file === file && memo.mtimeMs === st.mtimeMs) return memo.logo;
    const buf = await readFile(`${dir()}/${file}`);
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const logo: StationLogo = {
      buf,
      mime: mimeForExt(ext),
      mtimeMs: st.mtimeMs,
      version: `${Math.round(st.mtimeMs).toString(36)}${buf.length.toString(36)}`,
    };
    memo = { file, mtimeMs: st.mtimeMs, logo };
    return logo;
  } catch {
    return null;
  }
}

/** Store an uploaded image, replacing any other format. The bytes decide the type. */
export async function save(buf: Buffer | null | undefined): Promise<StationLogo> {
  if (!buf?.length) throw new Error('no image received');
  if (buf.length > MAX_LOGO_BYTES) {
    throw new Error(`image too large (max ${MAX_LOGO_BYTES} bytes, got ${buf.length})`);
  }
  const sniffed = sniffMime(buf);
  if (!sniffed) throw new Error('the image is not a PNG, JPEG or WebP');

  const file = `${BASENAME}.${extForMime(sniffed)}`;
  await mkdir(dir(), { recursive: true });
  const tmp = `${dir()}/.${file}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, `${dir()}/${file}`);
  for (const other of await existingFiles()) {
    if (other !== file) await unlink(`${dir()}/${other}`).catch(() => {});
  }
  memo = null;
  const logo = await read();
  if (!logo) throw new Error('the logo was written but cannot be read back');
  return logo;
}

/** Remove the logo; true when there was one. */
export async function clear(): Promise<boolean> {
  const files = await existingFiles();
  await Promise.all(files.map(f => unlink(`${dir()}/${f}`).catch(() => {})));
  memo = null;
  return files.length > 0;
}
