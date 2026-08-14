import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import type { TrackEntry, TrackFormat } from '@music-sync/shared';
import type { ArtworkStore } from './artwork.js';
import type { IndexStore } from './store.js';

export type MetadataParser = (filePath: string) => Promise<IAudioMetadata>;

export interface IndexOptions {
  /** Injectable metadata parser (tests count calls / force failures). Defaults to music-metadata parseFile. */
  parse?: MetadataParser;
}

export type IndexOutcome = 'indexed' | 'reused' | 'skipped';

export interface ScanStats {
  total: number;
  indexed: number;
  reused: number;
  removed: number;
}

const CHUNK_SIZE = 64 * 1024;

/**
 * Extensions we index. Formats AVPlayer cannot play are still indexed as 'unsupported'
 * (with best-effort metadata); extensions absent from this map are skipped entirely.
 */
const EXTENSION_FORMATS: Record<string, TrackFormat> = {
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'm4a', // refined to 'alac' when the codec says so
  '.aac': 'aac',
  '.wav': 'wav',
  '.aiff': 'aiff',
  '.aif': 'aiff',
  '.ogg': 'unsupported',
  '.opus': 'unsupported',
  '.wma': 'unsupported',
  '.mka': 'unsupported',
  '.webm': 'unsupported',
};

export function formatForFile(fileName: string): TrackFormat | undefined {
  return EXTENSION_FORMATS[path.extname(fileName).toLowerCase()];
}

/** Track identity: sha1 of the relative path (forward slashes). */
export function trackId(relPath: string): string {
  return createHash('sha1').update(relPath, 'utf8').digest('hex');
}

/** Relative path from the music root, normalized to forward slashes (Windows gives backslashes). */
export function relativeTrackPath(musicDir: string, absPath: string): string {
  return path.relative(musicDir, absPath).split(path.sep).join('/');
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

/**
 * Content identity: sha1 over (first 64KB + last 64KB + ascii byte size).
 * Files under 128KB hash (whole file + size) once — no overlap double-count.
 */
export async function computeContentKey(filePath: string, size?: number): Promise<string> {
  const byteSize = size ?? (await fsp.stat(filePath)).size;
  const hash = createHash('sha1');
  const handle = await fsp.open(filePath, 'r');
  try {
    if (byteSize < 2 * CHUNK_SIZE) {
      hash.update(await readExact(handle, byteSize, 0));
    } else {
      hash.update(await readExact(handle, CHUNK_SIZE, 0));
      hash.update(await readExact(handle, CHUNK_SIZE, byteSize - CHUNK_SIZE));
    }
  } finally {
    await handle.close();
  }
  hash.update(String(byteSize), 'ascii');
  return hash.digest('hex');
}

const defaultParse: MetadataParser = (filePath) => parseFile(filePath);

async function buildEntry(
  absPath: string,
  relPath: string,
  format: TrackFormat,
  size: number,
  mtimeMs: number,
  contentKey: string,
  artwork: ArtworkStore,
  parse: MetadataParser,
): Promise<TrackEntry> {
  const stem = path.basename(absPath, path.extname(absPath));
  const entry: TrackEntry = {
    id: trackId(relPath),
    path: relPath,
    size,
    mtimeMs,
    contentKey,
    format,
    title: stem,
    artist: 'Unknown Artist',
    album: '',
    durationSec: 0,
  };

  try {
    const meta = await parse(absPath);
    if (format === 'm4a' && (meta.format.codec ?? '').toUpperCase().includes('ALAC')) {
      entry.format = 'alac';
    }
    const common = meta.common;
    if (common.title) entry.title = common.title;
    if (common.artist) entry.artist = common.artist;
    if (common.albumartist) entry.albumArtist = common.albumartist;
    if (common.album) entry.album = common.album;
    if (common.track.no != null) entry.trackNo = common.track.no;
    if (common.disk.no != null) entry.discNo = common.disk.no;
    if (common.year != null) entry.year = common.year;
    const genre = common.genre?.[0];
    if (genre) entry.genre = genre;
    if (meta.format.duration != null && meta.format.duration >= 0) {
      entry.durationSec = meta.format.duration;
    }
    const picture = common.picture?.[0];
    if (picture) entry.artworkId = await artwork.put(picture.data, picture.format);
  } catch {
    // Unparseable file: keep the filename/dirname fallbacks already in place.
  }

  return entry;
}

/**
 * (Re-)index a single file. Fast path: an existing entry with identical
 * (size, mtimeMs) is reused without reading the file at all.
 */
export async function indexFile(
  musicDir: string,
  absPath: string,
  store: IndexStore,
  artwork: ArtworkStore,
  options: IndexOptions = {},
): Promise<IndexOutcome> {
  const format = formatForFile(absPath);
  if (format === undefined) return 'skipped';

  const stat = await fsp.stat(absPath);
  const relPath = relativeTrackPath(musicDir, absPath);
  const existing = store.get(relPath);
  if (existing !== undefined && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
    return 'reused';
  }

  const contentKey = await computeContentKey(absPath, stat.size);
  const parse = options.parse ?? defaultParse;
  const entry = await buildEntry(
    absPath,
    relPath,
    format,
    stat.size,
    stat.mtimeMs,
    contentKey,
    artwork,
    parse,
  );
  store.upsert(entry);
  return 'indexed';
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue; // skip dot-files and dot-dirs
    const absPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collectFiles(absPath, out);
    } else if (dirent.isFile() && formatForFile(dirent.name) !== undefined) {
      out.push(absPath);
    }
  }
}

/**
 * Full recursive scan of the music folder. Removes stored entries whose files
 * are gone, bumps rev once if anything changed, and schedules a persist.
 */
export async function scanLibrary(
  musicDir: string,
  store: IndexStore,
  artwork: ArtworkStore,
  options: IndexOptions = {},
): Promise<ScanStats> {
  const files: string[] = [];
  await collectFiles(musicDir, files);
  files.sort();

  const seen = new Set<string>();
  let indexed = 0;
  let reused = 0;
  for (const absPath of files) {
    seen.add(relativeTrackPath(musicDir, absPath));
    const outcome = await indexFile(musicDir, absPath, store, artwork, options);
    if (outcome === 'indexed') indexed += 1;
    else if (outcome === 'reused') reused += 1;
  }

  let removed = 0;
  for (const relPath of store.paths()) {
    if (!seen.has(relPath)) {
      store.remove(relPath);
      removed += 1;
    }
  }

  if (indexed > 0 || removed > 0) {
    store.bumpRev();
    store.schedulePersist();
  }

  return { total: seen.size, indexed, reused, removed };
}
