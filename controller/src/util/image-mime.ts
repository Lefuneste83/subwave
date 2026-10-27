// The one image-type check for operator uploads (persona avatars, the station
// logo). A data-URL prefix is easy to fake, so the decoded bytes decide.

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export function sniffMime(buf: Buffer): ImageMime | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

export function extForMime(mime: string): 'png' | 'jpg' | 'webp' {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export function mimeForExt(ext: string): ImageMime {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}
