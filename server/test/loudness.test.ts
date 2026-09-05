import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TrackEntry } from '@music-sync/shared';
import { LoudnessScanner, needsLoudness, parseEbur128 } from '../src/loudness.js';
import { IndexStore } from '../src/store.js';

const EBUR128_SUMMARY = `
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:          -8.3 LUFS
    Threshold: -18.3 LUFS

  Loudness range:
    LRA:         3.7 LU
    Threshold: -28.3 LUFS
    LRA low:   -10.3 LUFS
    LRA high:   -6.7 LUFS

  True peak:
    Peak:        2.6 dBFS
[out#0/null @ 0x2] video:0KiB audio:45674KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:04:03.59 bitrate=N/A speed=65.4x elapsed=0:00:03.72
`;

describe('parseEbur128', () => {
  it('reads integrated loudness and true peak from the summary block', () => {
    expect(parseEbur128(EBUR128_SUMMARY)).toEqual({ loudness: -8.3, truePeak: 2.6 });
  });

  it('takes the last summary when progress lines also print I: values', () => {
    const withProgress =
      '[Parsed_ebur128_0] t: 1.0 TARGET:-23 LUFS M: -20.1 S: -21.0 I: -22.5 LUFS  LRA: 0.0 LU\n' +
      EBUR128_SUMMARY;
    expect(parseEbur128(withProgress)).toEqual({ loudness: -8.3, truePeak: 2.6 });
  });

  it('returns undefined for silent input (-inf) or missing sections', () => {
    expect(parseEbur128(EBUR128_SUMMARY.replace('-8.3 LUFS', '-inf LUFS'))).toBeUndefined();
    expect(parseEbur128('garbage')).toBeUndefined();
  });
});

function entry(relPath: string, overrides: Partial<TrackEntry> = {}): TrackEntry {
  return {
    id: relPath,
    path: relPath,
    size: 1,
    mtimeMs: 1,
    contentKey: `ck-${relPath}`,
    format: 'mp3',
    title: relPath,
    artist: 'A',
    album: '',
    durationSec: 1,
    ...overrides,
  };
}

let dataDir: string;

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-loud-'));
});

afterAll(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('needsLoudness', () => {
  it('is true only for playable entries without a value', () => {
    expect(needsLoudness(entry('a.mp3'))).toBe(true);
    expect(needsLoudness(entry('a.mp3', { loudness: -12, truePeak: -1 }))).toBe(false);
    expect(needsLoudness(entry('a.ogg', { format: 'unsupported' }))).toBe(false);
  });
});

describe('LoudnessScanner', () => {
  it('measures unmeasured playable entries, writes values back, bumps rev once', async () => {
    const store = new IndexStore(path.join(dataDir, 'index-a.json'));
    store.upsert(entry('a.mp3'));
    store.upsert(entry('b.mp3', { loudness: -14, truePeak: -2 }));
    store.upsert(entry('c.ogg', { format: 'unsupported' }));
    store.upsert(entry('bad.mp3'));
    const rev = store.rev;

    const measure = vi.fn(async (filePath: string) =>
      filePath.endsWith('bad.mp3') ? undefined : { loudness: -9.5, truePeak: 1.2 },
    );
    const scanner = new LoudnessScanner('/music', store, { measure, log: () => undefined });
    await scanner.request();

    expect(measure.mock.calls.map(([p]) => p).sort()).toEqual([
      path.join('/music', 'a.mp3'),
      path.join('/music', 'bad.mp3'),
    ]);
    expect(store.get('a.mp3')).toMatchObject({ loudness: -9.5, truePeak: 1.2 });
    expect(store.get('b.mp3')).toMatchObject({ loudness: -14, truePeak: -2 });
    expect(store.get('c.ogg')?.loudness).toBeUndefined();
    expect(store.rev).toBe(rev + 1);

    // Unreadable file is remembered: a second pass has nothing to do and does not bump rev.
    await scanner.request();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(store.rev).toBe(rev + 1);
    expect(scanner.pendingCount()).toBe(0);
  });

  it('drops a result when the file changed while it was being measured', async () => {
    const store = new IndexStore(path.join(dataDir, 'index-b.json'));
    store.upsert(entry('a.mp3'));
    const measure = vi.fn(async () => {
      store.upsert(entry('a.mp3', { contentKey: 'ck-new' })); // re-indexed mid-measurement
      return { loudness: -10, truePeak: 0 };
    });
    const scanner = new LoudnessScanner('/music', store, { measure, log: () => undefined });
    await scanner.request();
    expect(store.get('a.mp3')?.loudness).toBeUndefined();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('coalesces requests made during a pass into one follow-up pass', async () => {
    const store = new IndexStore(path.join(dataDir, 'index-c.json'));
    store.upsert(entry('a.mp3'));
    let late = false;
    const measure = vi.fn(async () => {
      if (!late) {
        late = true;
        store.upsert(entry('z.mp3')); // watcher adds a file mid-pass
        void scanner.request();
        void scanner.request();
      }
      return { loudness: -11, truePeak: -0.5 };
    });
    const scanner = new LoudnessScanner('/music', store, { measure, log: () => undefined });
    await scanner.request();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(store.get('z.mp3')?.loudness).toBe(-11);
  });

  it('stops the pass when ffmpeg itself is missing', async () => {
    const store = new IndexStore(path.join(dataDir, 'index-d.json'));
    store.upsert(entry('a.mp3'));
    store.upsert(entry('b.mp3'));
    const measure = vi.fn(async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    });
    const log = vi.fn();
    const scanner = new LoudnessScanner('/music', store, { measure, log, concurrency: 1 });
    await scanner.request();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(store.get('a.mp3')?.loudness).toBeUndefined();
    expect(log.mock.calls.some(([m]) => String(m).includes('ENOENT'))).toBe(true);
  });
});
