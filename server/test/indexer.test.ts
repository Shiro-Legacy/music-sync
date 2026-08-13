import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArtworkStore } from '../src/artwork.js';
import { scanLibrary, trackId } from '../src/indexer.js';
import { IndexStore } from '../src/store.js';

let musicDir: string;
let dataDir: string;
let store: IndexStore;
let artwork: ArtworkStore;

// Garbage-byte files make music-metadata fail, exercising the fallback path;
// the mock also lets us count parse attempts to prove the fast path skips them.
const parse = vi.fn((filePath: string) =>
  Promise.reject(new Error(`unparseable: ${filePath}`)),
);

function sha1(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

async function writeTrack(relPath: string, content: string): Promise<void> {
  const absPath = path.join(musicDir, ...relPath.split('/'));
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, Buffer.from(content, 'utf8'));
}

beforeAll(async () => {
  musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-music-'));
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-data-'));
  store = new IndexStore(path.join(dataDir, 'index.json'));
  artwork = new ArtworkStore(path.join(dataDir, 'artwork'), store);

  await writeTrack('a.mp3', 'garbage mp3 bytes AAAA');
  await writeTrack('sub/b.mp3', 'garbage mp3 bytes BBBB');
  await writeTrack('d.ogg', 'garbage ogg bytes DDDD');
  await writeTrack('f.aif', 'garbage aiff bytes FFFF');
  await writeTrack('e.txt', 'not audio at all');
  await writeTrack('.hidden.mp3', 'dot file, must be skipped');
  await writeTrack('.hiddendir/c.mp3', 'inside dot dir, must be skipped');
});

afterAll(async () => {
  await fsp.rm(musicDir, { recursive: true, force: true });
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('scanLibrary', () => {
  it('indexes supported and unsupported audio, skipping dot-files and unknown extensions', async () => {
    const stats = await scanLibrary(musicDir, store, artwork, { parse });

    expect(stats.total).toBe(4);
    expect(stats.indexed).toBe(4);
    expect(stats.reused).toBe(0);
    expect(stats.removed).toBe(0);
    expect(store.rev).toBe(1);

    const paths = store
      .entries()
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['a.mp3', 'd.ogg', 'f.aif', 'sub/b.mp3']);
  });

  it('uses forward-slash relative paths and hashes them into ids', () => {
    const nested = store.get('sub/b.mp3');
    expect(nested).toBeDefined();
    expect(nested!.path).toBe('sub/b.mp3');
    expect(nested!.path).not.toContain('\\');
    expect(nested!.id).toBe(sha1('sub/b.mp3'));
    expect(nested!.id).toBe(trackId('sub/b.mp3'));
    expect(store.getById(nested!.id)).toBe(nested);

    const root = store.get('a.mp3');
    expect(root!.id).toBe(sha1('a.mp3'));
  });

  it('falls back to filename/dirname metadata when parsing fails', () => {
    const nested = store.get('sub/b.mp3')!;
    expect(nested.title).toBe('b');
    expect(nested.artist).toBe('Unknown Artist');
    expect(nested.album).toBe('sub');
    expect(nested.durationSec).toBe(0);
    expect(nested.format).toBe('mp3');
    expect(nested.contentKey).toMatch(/^[0-9a-f]{40}$/);
  });

  it('marks .ogg as unsupported but still indexes it, and maps .aif to aiff', () => {
    expect(store.get('d.ogg')!.format).toBe('unsupported');
    expect(store.get('f.aif')!.format).toBe('aiff');
    expect(parse).toHaveBeenCalledTimes(4); // best-effort metadata was attempted for all four
  });

  it('never indexes skipped extensions or dot-files', () => {
    expect(store.get('e.txt')).toBeUndefined();
    expect(store.get('.hidden.mp3')).toBeUndefined();
    expect(store.get('.hiddendir/c.mp3')).toBeUndefined();
  });

  it('reuses entries untouched on a rescan with no changes (fast path, no file reads)', async () => {
    const before = store.get('a.mp3');
    const revBefore = store.rev;
    const parseCallsBefore = parse.mock.calls.length;

    const stats = await scanLibrary(musicDir, store, artwork, { parse });

    expect(stats.indexed).toBe(0);
    expect(stats.reused).toBe(4);
    expect(stats.removed).toBe(0);
    expect(parse.mock.calls.length).toBe(parseCallsBefore); // metadata never re-read
    expect(store.get('a.mp3')).toBe(before); // identical entry object, not rebuilt
    expect(store.rev).toBe(revBefore); // no change, no rev bump
  });

  it('recomputes contentKey when file content changes', async () => {
    const oldEntry = store.get('a.mp3')!;
    await writeTrack('a.mp3', 'completely different and longer garbage mp3 bytes AAAA v2');

    const stats = await scanLibrary(musicDir, store, artwork, { parse });

    expect(stats.indexed).toBe(1);
    expect(stats.reused).toBe(3);
    const newEntry = store.get('a.mp3')!;
    expect(newEntry).not.toBe(oldEntry);
    expect(newEntry.contentKey).not.toBe(oldEntry.contentKey);
    expect(newEntry.id).toBe(oldEntry.id); // same path, same identity
    expect(store.rev).toBe(2);
  });

  it('removes entries whose files are gone', async () => {
    await fsp.rm(path.join(musicDir, 'd.ogg'));

    const stats = await scanLibrary(musicDir, store, artwork, { parse });

    expect(stats.removed).toBe(1);
    expect(store.get('d.ogg')).toBeUndefined();
    expect(store.rev).toBe(3);
    expect(store.trackCount).toBe(3);
  });
});
