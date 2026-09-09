import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ImportJobResponseSchema,
  ImportListResponseSchema,
  ImportPreviewResponseSchema,
} from '@music-sync/shared';
import { ArtworkStore } from '../src/artwork.js';
import { buildServer, digestToken } from '../src/http.js';
import {
  assertImportable,
  ImportError,
  ImportQueue,
  importAbsPath,
  importRelPath,
  killTrackedChildren,
  LibraryImports,
  publishExclusive,
  runDetached,
  ytdlpCommonArgs,
  type ImportHooks,
  type ImportTools,
} from '../src/imports.js';
import { trackId } from '../src/indexer.js';
import { IndexStore } from '../src/store.js';

const TOKEN = 'import-token-abcdefghijklmnopqrstuv';
const TOKEN_B = 'import-token-B-abcdefghijklmnopqrst';
const SERVER_ID = 'srv-import-a';
const SERVER_ID_B = 'srv-import-b';
const VIDEO = 'abcdefghijk';
const URL = `https://www.youtube.com/watch?v=${VIDEO}`;
const DASH_ID = '-abcDEFghij';
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fakeYtdlp = path.join(fixtureDir, 'fixtures', 'fake-ytdlp.mjs');
const fakeFfmpeg = path.join(fixtureDir, 'fixtures', 'fake-ffmpeg.mjs');
const fakeFfprobe = path.join(fixtureDir, 'fixtures', 'fake-ffprobe.mjs');

const fakeTools: ImportTools = {
  ytdlpPath: fakeYtdlp,
  ffmpegPath: fakeFfmpeg,
  ffprobePath: fakeFfprobe,
  ffmpegDir: path.dirname(fakeFfmpeg),
};

const okMeta = {
  id: VIDEO,
  title: 'Fixture title',
  artist: 'Fixture artist',
  duration: 2,
  is_live: false,
  live_status: 'not_live',
  thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
};

const tmpDirs: string[] = [];
const queues: ImportQueue[] = [];

afterEach(() => {
  killTrackedChildren();
});

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function authHeaders(serverId = SERVER_ID, token = TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-musicsync-server-id': serverId,
    'content-type': 'application/json',
  };
}

async function waitUntil<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  let last: T | undefined | false;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting: ${JSON.stringify(last)}`);
}

function previewMeta(id = VIDEO): unknown {
  return { ...okMeta, id };
}

async function makeImporter(
  hooks: ImportHooks = {},
): Promise<{
  importer: LibraryImports;
  musicDir: string;
  jobsPath: string;
  store: IndexStore;
  artwork: ArtworkStore;
  queue: ImportQueue;
}> {
  const root = await tempDir('msync-imp-');
  const musicDir = path.join(root, 'music');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(musicDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const store = new IndexStore(path.join(dataDir, 'index.json'));
  const artwork = new ArtworkStore(path.join(dataDir, 'artwork'), store);
  const queue = new ImportQueue();
  queues.push(queue);
  const jobsPath = path.join(dataDir, 'imports-alice.json');
  const importer = new LibraryImports({
    name: 'alice',
    musicDir,
    jobsPath,
    store,
    artwork,
    queue,
    hooks: {
      tools: async () => ({ ok: true, tools: fakeTools }),
      previewMeta: async () => previewMeta(),
      ...hooks,
    },
  });
  return { importer, musicDir, jobsPath, store, artwork, queue };
}

async function writeAudio(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, Buffer.alloc(2048, 1));
}

describe('assertImportable', () => {
  it('rejects missing duration, long videos, and live/upcoming/post-live', () => {
    expect(() => assertImportable({ title: 'x' })).toThrow(ImportError);
    expect(() => assertImportable({ ...okMeta, duration: 1801 })).toThrow(ImportError);
    expect(() => assertImportable({ ...okMeta, is_live: true })).toThrow(ImportError);
    expect(() => assertImportable({ ...okMeta, live_status: 'is_upcoming' })).toThrow(ImportError);
    expect(() => assertImportable({ ...okMeta, live_status: 'post_live' })).toThrow(ImportError);
    expect(assertImportable(okMeta).durationSec).toBe(2);
  });

  it('omits non-https thumbnails', () => {
    expect(assertImportable({ ...okMeta, thumbnail: 'http://example.com/a.jpg' }).thumbnailUrl).toBeUndefined();
    expect(assertImportable(okMeta).thumbnailUrl).toMatch(/^https:/);
  });
});

describe('ytdlpCommonArgs', () => {
  it('uses the fixed safe flag set', () => {
    const args = ytdlpCommonArgs(fakeTools);
    expect(args).toEqual(expect.arrayContaining([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-remote-components',
      '--no-playlist',
      '--no-cookies',
      '--use-extractors',
      'youtube$',
      '--js-runtimes',
      `node:${process.execPath}`,
      '--ffmpeg-location',
      fakeTools.ffmpegDir,
    ]));
    expect(args.join(' ')).not.toContain('--cookies-from-browser');
  });
});

describe('publishExclusive', () => {
  it('hard-links without clobbering an existing dest', async () => {
    const dir = await tempDir('msync-link-');
    const src = path.join(dir, 'src.m4a');
    const dest = path.join(dir, 'YouTube', `${VIDEO}.m4a`);
    await writeAudio(src);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, 'old-bytes');
    expect(await publishExclusive(src, dest)).toBe('exists');
    expect(await fsp.readFile(dest, 'utf8')).toBe('old-bytes');
  });
});

describe('LibraryImports', () => {
  it('persists a queued job before the downloader starts and reaches ready after index', async () => {
    let started = false;
    const { importer, jobsPath, store, musicDir } = await makeImporter({
      download: async ({ stagingDir, videoId }) => {
        started = true;
        const persisted = JSON.parse(await fsp.readFile(jobsPath, 'utf8')) as {
          jobs: Array<{ videoId: string; state: string }>;
        };
        expect(persisted.jobs.some((job) => job.videoId === videoId)).toBe(true);
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });

    const { job, existingReady } = await importer.submit({
      url: URL,
      title: 'Song',
      artist: 'Artist',
    });
    expect(existingReady).toBe(false);
    expect(['queued', 'downloading']).toContain(job.state);
    const onDisk = JSON.parse(await fsp.readFile(jobsPath, 'utf8')) as { jobs: unknown[] };
    expect(onDisk.jobs).toHaveLength(1);

    const ready = await waitUntil(async () => {
      const listed = await importer.list();
      const current = listed.jobs.find((item) => item.id === job.id);
      return current?.state === 'ready' ? current : undefined;
    });
    expect(started).toBe(true);
    expect(ready.trackId).toBe(trackId(importRelPath(VIDEO)));
    expect(store.getById(ready.trackId!)).toBeDefined();
    expect(store.get(importRelPath(VIDEO))).toBeDefined();
    await fsp.access(importAbsPath(musicDir, VIDEO));
  });

  it('returns the in-flight job instead of starting a second download', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { importer } = await makeImporter({
      download: async ({ stagingDir }) => {
        await gate;
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });
    const first = await importer.submit({ url: URL, title: 'A', artist: 'B' });
    const second = await importer.submit({ url: URL, title: 'Other', artist: 'Else' });
    expect(second.job.id).toBe(first.job.id);
    release();
    await waitUntil(async () => {
      const listed = await importer.list();
      return listed.jobs[0]?.state === 'ready';
    });
  });

  it('returns existing ready when the track is already indexed', async () => {
    const { importer, store, musicDir, artwork } = await makeImporter();
    const dest = importAbsPath(musicDir, VIDEO);
    await writeAudio(dest);
    const { indexFile } = await import('../src/indexer.js');
    await indexFile(musicDir, dest, store, artwork);
    const result = await importer.submit({ url: URL, title: 'A', artist: 'B' });
    expect(result.existingReady).toBe(true);
    expect(result.job.state).toBe('ready');
    expect(result.job.trackId).toBe(trackId(importRelPath(VIDEO)));
  });

  it('creates a new job after failure, and never indexes a partial download', async () => {
    let attempt = 0;
    const { importer, store } = await makeImporter({
      download: async ({ stagingDir }) => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom /tmp/secret.m4a');
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });
    const first = await importer.submit({ url: URL, title: 'A', artist: 'B' });
    const failed = await waitUntil(async () => {
      const listed = await importer.list();
      const current = listed.jobs.find((item) => item.id === first.job.id);
      return current?.state === 'failed' ? current : undefined;
    });
    expect(failed.error).not.toMatch(/\/tmp\/secret/);
    expect(store.get(importRelPath(VIDEO))).toBeUndefined();

    const retry = await importer.submit({ url: URL, title: 'A', artist: 'B' });
    expect(retry.job.id).not.toBe(first.job.id);
    await waitUntil(async () => {
      const listed = await importer.list();
      return listed.jobs.find((item) => item.id === retry.job.id)?.state === 'ready';
    });
  });

  it('returns 429 when the global queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { importer } = await makeImporter({
      download: async ({ stagingDir }) => {
        await gate;
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });
    const alphabet = 'abcdefghijk0123456789ABCDEFGHIJKLMNOP';
    const submits = [];
    for (let i = 0; i < 11; i += 1) {
      const videoId = `${alphabet[i] ?? 'a'}bcdefghijk`.slice(0, 11);
      submits.push(
        importer.submit({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          title: 'A',
          artist: 'B',
        }),
      );
    }
    await Promise.all(submits);
    await expect(
      importer.submit({ url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', title: 'A', artist: 'B' }),
    ).rejects.toMatchObject({ status: 429, message: 'import queue full' });
    release();
  });

  it('returns 429 when two previews are already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { importer } = await makeImporter({
      previewMeta: async () => {
        await gate;
        return previewMeta();
      },
    });
    const first = importer.preview(URL);
    const second = importer.preview(URL);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(importer.preview(URL)).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all([first, second]);
  });

  it('does not overwrite a corrupt jobs file and reports unavailable', async () => {
    const { importer, jobsPath } = await makeImporter();
    await fsp.writeFile(jobsPath, '{not-json', 'utf8');
    const broken = new LibraryImports({
      name: 'alice',
      musicDir: path.dirname(jobsPath),
      jobsPath,
      store: new IndexStore(path.join(path.dirname(jobsPath), 'index.json')),
      artwork: new ArtworkStore(path.join(path.dirname(jobsPath), 'art'), new IndexStore(path.join(path.dirname(jobsPath), 'index.json'))),
      queue: new ImportQueue(),
      hooks: { tools: async () => ({ ok: true, tools: fakeTools }) },
    });
    const listed = await broken.list();
    expect(listed.available).toBe(false);
    expect(listed.unavailableReason).toMatch(/corrupt/);
    await expect(broken.submit({ url: URL, title: 'A', artist: 'B' })).rejects.toMatchObject({
      status: 503,
    });
    expect(await fsp.readFile(jobsPath, 'utf8')).toBe('{not-json');
  });

  it('reconciles interrupted jobs to failed, or ready when the file is already indexed', async () => {
    const { jobsPath, store, musicDir, artwork } = await makeImporter();
    const dest = importAbsPath(musicDir, VIDEO);
    await writeAudio(dest);
    const { indexFile } = await import('../src/indexer.js');
    await indexFile(musicDir, dest, store, artwork);
    const stamp = new Date().toISOString();
    await fsp.writeFile(
      jobsPath,
      `${JSON.stringify({
        v: 1,
        jobs: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            videoId: VIDEO,
            url: URL,
            title: 'A',
            artist: 'B',
            state: 'downloading',
            createdAt: stamp,
            updatedAt: stamp,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            videoId: 'otheridxxxx',
            url: 'https://www.youtube.com/watch?v=otheridxxxx',
            title: 'C',
            artist: 'D',
            state: 'queued',
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
      })}\n`,
      'utf8',
    );
    const rest = new LibraryImports({
      name: 'alice',
      musicDir,
      jobsPath,
      store,
      artwork,
      queue: new ImportQueue(),
      hooks: { tools: async () => ({ ok: true, tools: fakeTools }) },
    });
    await rest.reconcile();
    const listed = await rest.list();
    const downloaded = listed.jobs.find((job) => job.videoId === VIDEO);
    const queued = listed.jobs.find((job) => job.videoId === 'otheridxxxx');
    expect(downloaded?.state).toBe('ready');
    expect(downloaded?.trackId).toBe(trackId(importRelPath(VIDEO)));
    expect(queued?.state).toBe('failed');
    expect(queued?.error).toMatch(/restart/i);
  });

  it('runs the real tag/probe/download path through fake executables', async () => {
    await Promise.all([fakeYtdlp, fakeFfmpeg, fakeFfprobe].map((file) => fsp.chmod(file, 0o755)));
    const root = await tempDir('msync-fake-');
    const musicDir = path.join(root, 'music');
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(musicDir, { recursive: true });
    const store = new IndexStore(path.join(dataDir, 'index.json'));
    const artwork = new ArtworkStore(path.join(dataDir, 'artwork'), store);
    const real = new LibraryImports({
      name: 'alice',
      musicDir,
      jobsPath: path.join(dataDir, 'imports-alice.json'),
      store,
      artwork,
      queue: new ImportQueue(),
      hooks: { tools: async () => ({ ok: true, tools: fakeTools }) },
    });
    const { job } = await real.submit({ url: URL, title: 'Tagged %(title)s', artist: 'Artist' });
    const ready = await waitUntil(async () => {
      const listed = await real.list();
      const current = listed.jobs.find((item) => item.id === job.id);
      return current?.state === 'ready' ? current : undefined;
    });
    expect(ready.trackId).toBe(trackId(importRelPath(VIDEO)));
    expect(store.getById(ready.trackId!)).toBeDefined();
    await expect(
      fsp.access(path.join(musicDir, '.music-sync-imports', job.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a video id that starts with a dash using absolute paths', async () => {
    const { importer, musicDir, store } = await makeImporter({
      previewMeta: async () => previewMeta(DASH_ID),
      download: async ({ stagingDir, videoId }) => {
        expect(videoId).toBe(DASH_ID);
        expect(path.isAbsolute(stagingDir)).toBe(true);
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });
    const { job } = await importer.submit({
      url: `https://www.youtube.com/watch?v=${DASH_ID}`,
      title: 'Dash',
      artist: 'Id',
    });
    const ready = await waitUntil(async () => {
      const listed = await importer.list();
      const current = listed.jobs.find((item) => item.id === job.id);
      return current?.state === 'ready' ? current : undefined;
    });
    expect(ready.videoId).toBe(DASH_ID);
    expect(store.get(importRelPath(DASH_ID))).toBeDefined();
    await fsp.access(importAbsPath(musicDir, DASH_ID));
  });
});

describe('runDetached', () => {
  it('kills a timed-out child tree', async () => {
    await expect(
      runDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('import HTTP routes', () => {
  let app: FastifyInstance;
  let importer: LibraryImports;
  let musicDir: string;
  let store: IndexStore;

  beforeAll(async () => {
    const made = await makeImporter({
      download: async ({ stagingDir }) => {
        const out = path.join(stagingDir, 'out.m4a');
        await writeAudio(out);
        return out;
      },
      probe: async () => undefined,
    });
    importer = made.importer;
    musicDir = made.musicDir;
    store = made.store;
    const other = await makeImporter();
    app = await buildServer({
      name: 'TestPC',
      version: '0.0.0',
      libraries: [
        {
          name: 'alice',
          serverId: SERVER_ID,
          tokenDigest: digestToken(TOKEN),
          getRev: () => store.rev,
          getTracks: () => store.entries(),
          getTrackById: (id) => store.getById(id),
          getTrackFilePath: (entry) => path.join(musicDir, entry.path),
          getArtwork: () => undefined,
          imports: importer,
        },
        {
          name: 'bob',
          serverId: SERVER_ID_B,
          tokenDigest: digestToken(TOKEN_B),
          getRev: () => 0,
          getTracks: () => [],
          getTrackById: () => undefined,
          getTrackFilePath: () => '',
          getArtwork: () => undefined,
          imports: other.importer,
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces LAN, bearer, then server id, then body', async () => {
    const lan = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      remoteAddress: '8.8.8.8',
      headers: authHeaders(),
      payload: { url: URL },
    });
    expect(lan.statusCode).toBe(403);

    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: { 'x-musicsync-server-id': SERVER_ID, 'content-type': 'application/json' },
      payload: { url: URL },
    });
    expect(unauth.statusCode).toBe(401);

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: authHeaders('wrong-server'),
      payload: { url: 'not-a-url' },
    });
    expect(mismatch.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: authHeaders(),
      payload: { url: 'https://evil.com/watch?v=abcdefghijk' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('previews, submits, lists, and isolates libraries', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: authHeaders(),
      payload: { url: ` https://youtu.be/${VIDEO} ` },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = ImportPreviewResponseSchema.parse(preview.json());
    expect(previewBody.serverId).toBe(SERVER_ID);
    expect(previewBody.preview.videoId).toBe(VIDEO);
    expect(previewBody.preview.url).toBe(URL);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers: authHeaders(),
      payload: { url: URL, title: 'Song', artist: 'Artist' },
    });
    expect(created.statusCode).toBe(202);
    const createdBody = ImportJobResponseSchema.parse(created.json());
    expect(createdBody.job.videoId).toBe(VIDEO);

    await waitUntil(async () => {
      const listed = await importer.list();
      return listed.jobs.find((job) => job.id === createdBody.job.id)?.state === 'ready';
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/imports',
      headers: authHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    const listBody = ImportListResponseSchema.parse(listed.json());
    expect(listBody.available).toBe(true);
    expect(listBody.jobs[0]?.state).toBe('ready');

    const bob = await app.inject({
      method: 'GET',
      url: '/api/v1/imports',
      headers: authHeaders(SERVER_ID_B, TOKEN_B),
    });
    expect(ImportListResponseSchema.parse(bob.json()).jobs).toEqual([]);
  });

  it('returns 503 when tools are missing', async () => {
    const unavailable = new LibraryImports({
      name: 'alice',
      musicDir: await tempDir('msync-no-tools-'),
      jobsPath: path.join(await tempDir('msync-no-tools-j-'), 'imports-alice.json'),
      store: new IndexStore(path.join(os.tmpdir(), `msync-i-${Date.now()}.json`)),
      artwork: new ArtworkStore(await tempDir('msync-art-'), new IndexStore(path.join(os.tmpdir(), `msync-i2-${Date.now()}.json`))),
      queue: new ImportQueue(),
      hooks: { tools: async () => ({ ok: false, reason: 'yt-dlp not installed' }) },
    });
    const isolated = await buildServer({
      name: 'TestPC',
      version: '0.0.0',
      libraries: [
        {
          name: 'alice',
          serverId: SERVER_ID,
          tokenDigest: digestToken(TOKEN),
          getRev: () => 0,
          getTracks: () => [],
          getTrackById: () => undefined,
          getTrackFilePath: () => '',
          getArtwork: () => undefined,
          imports: unavailable,
        },
      ],
    });
    try {
      const res = await isolated.inject({
        method: 'GET',
        url: '/api/v1/imports',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = ImportListResponseSchema.parse(res.json());
      expect(body.available).toBe(false);
      expect(body.unavailableReason).toMatch(/yt-dlp/);
      const post = await isolated.inject({
        method: 'POST',
        url: '/api/v1/imports',
        headers: authHeaders(),
        payload: { url: URL, title: 'A', artist: 'B' },
      });
      expect(post.statusCode).toBe(503);
    } finally {
      await isolated.close();
    }
  });
});

