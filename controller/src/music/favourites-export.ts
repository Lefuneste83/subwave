// Favourites: the hearted songs (broadcast/likes.ts, any listener or the
// operator), listed, and with --out copied as their ORIGINAL files into a folder
// with an .m3u8 playlist and a CSV beside them — a party crate. `npm run
// favourites`. Read-only on the station: it reads likes.json and the library
// DB and never writes either; the copies are fetched through the music server
// (`stream` with format=raw: the stored bytes, no transcode), because the
// controller usually has no mount of the library.
//
//   npm run favourites                          list them (newest heart first)
//   npm run favourites -- --operator            only the operator's hearts
//   npm run favourites -- --min-likes 2         hearted at least twice
//   npm run favourites -- --starred             add songs starred in the music server
//   npm run favourites -- --out /var/sub-wave/party   copy the files there
//
// The copy is resumable: a file already in the folder at the size the music
// server reports is skipped, and each download lands under a .part name first,
// so an interrupted run never leaves a truncated file under a real name.
// The pure half (selection, names, playlist, CSV) is pinned by
// scripts/favourites-export.test.ts.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface Favourite {
  id: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  year: number | null;
  durationSec: number | null;
  likes: number;
  operator: boolean;
  starred: boolean;
  lastLikedAt: string | null;
  // The library id the copy is fetched by: the hearted id, or, when the music
  // server has since renumbered or moved the song, the one found by artist and
  // title (`matchedBy: 'name'`). null = not in the library any more.
  libraryId: string | null;
  matchedBy: 'id' | 'name' | null;
  filePath: string | null;
  fileSuffix: string | null;
  fileSize: number | null;
}

export interface SelectOptions {
  operatorOnly?: boolean;
  minLikes?: number;
}

// Which favourites a run takes, newest heart first; a star-only song (no heart)
// sorts after every hearted one.
export function selectFavourites(all: Favourite[], o: SelectOptions = {}): Favourite[] {
  const min = o.minLikes ?? 1;
  return all
    .filter(f => (o.operatorOnly ? f.operator : true))
    .filter(f => f.likes >= min || (f.starred && !o.operatorOnly && min <= 1))
    .sort((a, b) => (b.lastLikedAt ?? '').localeCompare(a.lastLikedAt ?? '') || a.id.localeCompare(b.id));
}

// A file name every OS and USB stick takes: no path separators, no reserved
// characters, no trailing dot or space, bounded length.
export function safeName(s: string): string {
  const cleaned = s
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'untitled').slice(0, 150);
}

// "Artist - Title.ext", the extension from the stored file, distinct within
// the run (a second copy of a name gets " (2)").
export function fileNames(favs: Favourite[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const f of favs) {
    const ext = (f.fileSuffix || (f.filePath?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]) || 'mp3').toLowerCase();
    const base = safeName(`${f.artist ?? 'Unknown artist'} - ${f.title ?? f.id}`);
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
    used.add(name.toLowerCase());
    out.set(f.id, name);
  }
  return out;
}

export function m3u8(favs: Favourite[], names: Map<string, string>): string {
  const lines = ['#EXTM3U'];
  for (const f of favs) {
    const name = names.get(f.id);
    if (!name || !f.libraryId) continue;
    lines.push(`#EXTINF:${Math.round(f.durationSec ?? -1)},${f.artist ?? ''} - ${f.title ?? ''}`, name);
  }
  return lines.join('\n') + '\n';
}

const csvField = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csv(favs: Favourite[], names?: Map<string, string>): string {
  const header = ['artist', 'title', 'album', 'year', 'duration_sec', 'likes', 'operator_heart', 'starred', 'last_liked_at', 'file', 'source_path', 'found_by', 'id'];
  const rows = favs.map(f => [
    f.artist, f.title, f.album, f.year, f.durationSec, f.likes, f.operator ? 'yes' : '', f.starred ? 'yes' : '',
    f.lastLikedAt, f.libraryId ? names?.get(f.id) ?? '' : '', f.filePath, f.matchedBy ?? 'missing', f.id,
  ].map(csvField).join(','));
  return [header.join(','), ...rows].join('\r\n') + '\r\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const flag = (args: string[], name: string) => args.includes(name);
const value = (args: string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : null;
};

async function gather(withStarred: boolean): Promise<Favourite[]> {
  const likes = await import('../broadcast/likes.js');
  const db = await import('./library-db.js');
  const subsonic = await import('./subsonic.js');
  await likes.load({ readOnly: true });
  const byId = new Map<string, Favourite>();
  type FileRow = { id: string; artist: string | null; title: string | null; album: string | null; year: number | null; duration_sec: number | null; file_path: string | null; file_suffix: string | null; file_size: number | null };
  const cols = 'id, artist, title, album, year, duration_sec, file_path, file_suffix, file_size';
  const byIdStmt = db.requireDb().prepare(`SELECT ${cols} FROM tracks WHERE id = ?`);
  const byNameStmt = db.requireDb().prepare(`SELECT ${cols} FROM tracks WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE ORDER BY id`);
  // The hearted id first; else the same artist and title, the same album when
  // there are several copies.
  const find = (id: string, snap: any): { t: FileRow; by: 'id' | 'name' } | null => {
    try {
      const t = byIdStmt.get(id) as FileRow | undefined;
      if (t) return { t, by: 'id' };
      if (!snap?.artist || !snap?.title) return null;
      const all = byNameStmt.all(snap.artist, snap.title) as FileRow[];
      const pick = all.find(r => snap.album && r.album?.toLowerCase() === String(snap.album).toLowerCase()) ?? all[0];
      return pick ? { t: pick, by: 'name' } : null;
    } catch { return null; }
  };
  const base = (id: string, snap: any): Favourite => {
    const hit = find(id, snap);
    const t = hit?.t;
    return {
      id,
      artist: t?.artist ?? snap?.artist ?? null,
      title: t?.title ?? snap?.title ?? null,
      album: t?.album ?? snap?.album ?? null,
      year: t?.year ?? snap?.year ?? null,
      durationSec: t?.duration_sec ?? snap?.duration ?? null,
      likes: 0, operator: false, starred: false, lastLikedAt: null,
      libraryId: t?.id ?? null, matchedBy: hit?.by ?? null,
      filePath: t?.file_path ?? null, fileSuffix: t?.file_suffix ?? null, fileSize: t?.file_size ?? null,
    };
  };
  for (const s of likes.likedSongs()) {
    byId.set(s.songId, { ...base(s.songId, s.track), likes: s.count, operator: s.operator, lastLikedAt: s.lastLikedAt });
  }
  if (withStarred) {
    for (const song of (await subsonic.getStarred()) as any[]) {
      if (!song?.id) continue;
      const cur = byId.get(song.id) ?? base(song.id, song);
      cur.starred = true;
      byId.set(song.id, cur);
    }
  }
  return [...byId.values()];
}

async function copy(favs: Favourite[], names: Map<string, string>, outDir: string): Promise<{ copied: number; skipped: number; failed: string[] }> {
  const subsonic = await import('./subsonic.js');
  mkdirSync(outDir, { recursive: true });
  let copied = 0, skipped = 0;
  const failed: string[] = [];
  for (const [i, f] of favs.entries()) {
    const name = names.get(f.id)!;
    const dest = join(outDir, name);
    const label = `[${i + 1}/${favs.length}] ${name}`;
    if (!f.libraryId) {
      failed.push(`${name}: not in the library any more`);
      console.log(`${label}  MISSING: not in the library any more`);
      continue;
    }
    try {
      const res = await fetch(subsonic.getRawStreamUrl(f.libraryId));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const size = Number(res.headers.get('content-length')) || f.fileSize || null;
      if (size && existsSync(dest) && statSync(dest).size === size) {
        await res.body.cancel();
        skipped++;
        console.log(`${label}  already there`);
        continue;
      }
      const part = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
      const got = statSync(part).size;
      if (size && got !== size) {
        unlinkSync(part);
        throw new Error(`short download (${got} of ${size} bytes)`);
      }
      renameSync(part, dest);
      copied++;
      console.log(`${label}  ${(statSync(dest).size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
      console.log(`${label}  FAILED: ${(err as Error).message}`);
    }
  }
  return { copied, skipped, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = await import('../setup/config.js');
  await cfg.loadNavidromeConfig();
  const settings = await import('../settings.js');
  await settings.load();
  const db = await import('./library-db.js');
  const embeddings = await import('./embeddings.js');
  await db.open({ embeddingDim: embeddings.resolveEmbeddingDim(), adoptStoredDim: true });

  const minLikes = Number(value(args, '--min-likes') ?? 1);
  const favs = selectFavourites(await gather(flag(args, '--starred')), {
    operatorOnly: flag(args, '--operator'),
    minLikes: Number.isFinite(minLikes) && minLikes >= 1 ? Math.floor(minLikes) : 1,
  });
  const names = fileNames(favs);
  const outDir = value(args, '--out');

  if (!outDir) {
    process.stdout.write(csv(favs, names));
    console.error(`${favs.length} favourites. Add --out <folder> to copy the original files there.`);
    process.exit(0);
  }
  const r = await copy(favs, names, outDir);
  writeFileSync(join(outDir, 'favourites.m3u8'), m3u8(favs, names));
  writeFileSync(join(outDir, 'favourites.csv'), csv(favs, names));
  console.log(`\n${favs.length} favourites → ${outDir}: ${r.copied} copied, ${r.skipped} already there, ${r.failed.length} failed; favourites.m3u8 + favourites.csv written`);
  for (const f of r.failed) console.log(`  failed: ${f}`);
  process.exit(r.failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
