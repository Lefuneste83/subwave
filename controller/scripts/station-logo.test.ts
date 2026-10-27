// The station logo (branding/station-logo.ts): stored, served at
// /station-logo for directory listings, and shown by /cover/:id for a track
// the music server has no artwork for (branding/cover-fallback.ts), against a
// fake Subsonic server on a real socket.
//
// Run: npm test -- station-logo

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-station-logo-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'logo-admin';
process.env.ADMIN_PASS = 'logo-pass';

const { config } = await import('../src/config.js');
const express = (await import('express')).default;
const { router: publicRoutes } = await import('../src/routes/public.js');
const { router: logoRoutes } = await import('../src/routes/station-logo.js');
const stationLogo = await import('../src/branding/station-logo.js');
const coverFallback = await import('../src/branding/cover-fallback.js');

// Minimal valid-looking images: the sniffer reads magic bytes only.
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag.padEnd(16, '.'))]);
const webp = (tag: string) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.from(tag.padEnd(16, '.'))]);
const ART = png('album-art');
const PLACEHOLDER = webp('nd-placeholder');

const fake = { requests: [] as string[], placeholderForEmpty: true };
const nd = await listen((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const id = u.searchParams.get('id');
  fake.requests.push(String(id));
  const img = (type: string, b: Buffer) => { res.writeHead(200, { 'Content-Type': type }); res.end(b); };
  if (u.pathname !== '/rest/getCoverArt') { res.writeHead(404); return res.end(); }
  if (id === '') {
    if (!fake.placeholderForEmpty) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"subsonic-response":{"status":"failed"}}'); }
    return img('image/webp', PLACEHOLDER);
  }
  if (id === 'withart') return img('image/png', ART);
  if (id === 'noart' || id === 'noart2' || id === 'noart3') return img('image/webp', PLACEHOLDER);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"subsonic-response":{"status":"failed","error":{"code":70,"message":"Artwork not found"}}}');
});
nd.server.unref();
config.navidrome.url = nd.url;

const app = express();
app.use(publicRoutes);
app.use(logoRoutes);
const { server, url: base } = await listen(app);
server.unref();
after(async () => { await removeTempDir(dir); });

const auth = { Authorization: `Basic ${Buffer.from('logo-admin:logo-pass').toString('base64')}` };
const get = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), etag: r.headers.get('etag'), location: r.headers.get('location'), body: Buffer.from(await r.arrayBuffer()) };
};
async function upload(buf: Buffer, type = 'image/png') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), 'logo');
  const r = await fetch(`${base}/settings/station-logo`, { method: 'PUT', headers: auth, body: fd });
  return { status: r.status, body: await r.json() as any };
}

beforeEach(async () => {
  await stationLogo.clear();
  coverFallback._reset();
  fake.placeholderForEmpty = true;
  fake.requests = [];
});

test('the admin uploads, reads and removes the logo; the bytes decide the type', async () => {
  assert.equal((await fetch(`${base}/settings/station-logo`)).status, 401);
  const up = await upload(png('logo-1'));
  assert.equal(up.status, 200);
  assert.equal(up.body.set, true);
  assert.equal(up.body.mime, 'image/png');
  const bad = await upload(Buffer.from('not an image at all'), 'image/png');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not a PNG, JPEG or WebP/);
  // A WebP replaces the PNG rather than sitting beside it.
  await upload(webp('logo-2'), 'image/webp');
  assert.equal((await stationLogo.read())?.mime, 'image/webp');
  const del = await fetch(`${base}/settings/station-logo`, { method: 'DELETE', headers: auth });
  assert.equal((await del.json() as any).set, false);
  assert.equal(await stationLogo.read(), null);
});

test('GET /station-logo serves the logo with an ETag, and redirects to the app icon without one', async () => {
  const none = await get('/station-logo');
  assert.equal(none.status, 302);
  assert.equal(none.location, '/icons/512');
  await upload(png('logo-1'));
  const r = await get('/station-logo');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.body, png('logo-1'));
  assert.equal((await get('/station-logo', { headers: { 'If-None-Match': r.etag! } })).status, 304);
});

test('without a logo nothing changes: art, the server placeholder, and no fingerprint request', async () => {
  const art = await get('/cover/withart');
  assert.deepEqual(art.body, ART);
  assert.match(art.cache || '', /immutable/);
  const ph = await get('/cover/noart');
  assert.deepEqual(ph.body, PLACEHOLDER, 'no logo: the placeholder, as before');
  assert.equal(fake.requests.includes(''), false, 'the placeholder is not even looked up');
});

test('with a logo, missing art and unknown ids show it, and a new logo shows at once', async () => {
  await upload(png('logo-1'));
  const r = await get('/cover/noart2');
  assert.deepEqual(r.body, png('logo-1'));
  assert.equal(r.cache, 'public, max-age=3600', 'not a day, not immutable: the logo can change');
  assert.deepEqual((await get('/cover/unknown2')).body, png('logo-1'));
  assert.deepEqual((await get('/cover/withart')).body, ART, 'real art always wins');
  await upload(png('logo-2'));
  assert.deepEqual((await get('/cover/noart2')).body, png('logo-2'), 'the LRU remembered "missing", not the old logo');
});

test('a server with no recognisable placeholder never has art replaced', async () => {
  fake.placeholderForEmpty = false;
  await upload(png('logo-1'));
  // A fresh id: the route's LRU outlives beforeEach.
  const ph = await get('/cover/noart3');
  assert.deepEqual(ph.body, PLACEHOLDER, 'unrecognised, so served as the server sent it');
  assert.equal(await coverFallback.isPlaceholder(PLACEHOLDER, 512), false, 'no fingerprint, no substitution');
});
