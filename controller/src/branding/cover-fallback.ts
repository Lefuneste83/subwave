// What "this track has no artwork" looks like coming back from the music
// server, so /cover/:id can show the station logo instead.
//
// The player asks for a cover by TRACK id, and Navidrome answers every id it
// knows: with the track's art, its album's, or, when there is none, its own
// placeholder image, as a normal 200. Nothing in that answer says "placeholder",
// so it is recognised by its bytes: Navidrome answers `getCoverArt` with an
// EMPTY id with that same placeholder at the requested size (measured on
// Navidrome: 69,228-byte WebP at 512 px, the same bytes it returned for five
// unrelated albums without art). The fingerprint is that answer's hash, taken
// once per size and kept. A server that answers the empty id with an error or
// a non-image has no fingerprint, and nothing is ever substituted on its
// account, which is the old behaviour.
//
// An id the server does not know comes back as a Subsonic error document
// (JSON, still HTTP 200), which is not an image at all: with a logo set, the
// route treats it as missing artwork too. The fingerprint is only ever learnt
// once a logo is set, so a station without one makes no extra request.

import { createHash } from 'node:crypto';
import * as subsonic from '../music/subsonic.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { recordHttpAttempt } from '../music/subsonic-log.js';

const RETRY_MS = 10 * 60_000;
const REFRESH_MS = 24 * 3_600_000;

interface Print { hash: string | null; at: number }
const prints = new Map<number, Print>();
const inflight = new Map<number, Promise<void>>();

export function hashOf(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function isImageType(contentType: string | null | undefined): boolean {
  return /^image\//i.test(String(contentType ?? ''));
}

/** A Subsonic error answer (JSON or XML, still HTTP 200), not a picture. */
export function isErrorDocument(contentType: string | null | undefined): boolean {
  return /^(application\/(json|xml)|text\/)/i.test(String(contentType ?? ''));
}

async function learn(size: number): Promise<void> {
  let hash: string | null = null;
  try {
    const url = new URL(subsonic.getCoverArtUrl('x', size));
    url.searchParams.set('id', '');
    recordHttpAttempt('getCoverArt', 'cover');
    const r = await fetchWithTimeout(url.toString(), { timeoutMs: 5000 });
    if (r.ok && isImageType(r.headers.get('content-type'))) {
      hash = hashOf(Buffer.from(await r.arrayBuffer()));
    }
  } catch { /* no fingerprint; retried after RETRY_MS */ }
  prints.set(size, { hash, at: Date.now() });
}

/**
 * True when `buf` is the music server's no-artwork placeholder at `size`.
 * Learns the fingerprint on first use (one request), and answers false while
 * it is unknown, so a server without a recognisable placeholder keeps the
 * old behaviour.
 */
export async function isPlaceholder(buf: Buffer, size: number): Promise<boolean> {
  const p = prints.get(size);
  const stale = !p || Date.now() - p.at > (p.hash ? REFRESH_MS : RETRY_MS);
  if (stale) {
    let job = inflight.get(size);
    if (!job) {
      job = learn(size).finally(() => inflight.delete(size));
      inflight.set(size, job);
    }
    await job;
  }
  const hash = prints.get(size)?.hash;
  return !!hash && hash === hashOf(buf);
}

/** Test hook. */
export function _reset(): void {
  prints.clear();
}
