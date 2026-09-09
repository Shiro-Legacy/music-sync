import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fetchImportPreview, listImports, submitImport, type ImportServer } from '../src/imports/client';

/**
 * App client <-> wire contract integration. A stub HTTP server stands in for
 * the desktop MusicSync server (no YouTube, no real network). The client must
 * speak the exact contract in shared/src/imports.ts: correct method/path,
 * bearer + X-MusicSync-Server-Id headers, parsed response envelopes, and
 * honest errors for non-2xx bodies.
 */

const CFG: ImportServer = {
  host: '127.0.0.1',
  port: 0,
  token: 'secret-token',
  serverId: 'srv-1234',
};

const videoId = 'dQw4w9WgXcQ';
const previewUrl = `https://www.youtube.com/watch?v=${videoId}`;

/** Requests the stub saw, in order, for assertions. */
const seen: { method: string; url: string; headers: Record<string, string | undefined>; body: unknown }[] = [];

/** Toggles the GET /imports payload so the client parses every shape. */
let listMode: 'available' | 'unavailable' | 'wrong-server' = 'available';

let server: Server;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw === '' ? null : JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function jobFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7f7a2d44-3c0e-4b1a-9b2f-1e6d3c8a5f01',
    videoId,
    url: previewUrl,
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    state: 'queued',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: {
        authorization: req.headers.authorization,
        serverId: req.headers['x-musicsync-server-id'] as string | undefined,
      },
      body,
    });
    const path = req.url?.split('?')[0];
    if (req.method === 'POST' && path === '/api/v1/imports/preview') {
      const { url } = body as { url?: string };
      if (url?.includes('unpaired')) return json(res, 401, { error: 'bad token' });
      if (url?.includes('busy')) return json(res, 429, { error: 'Import queue is busy' });
      if (url?.includes('repair')) return json(res, 409, {}); // no {error} body → status fallback
      if (url?.includes('legacy')) return json(res, 404, { error: 'not found' }); // old server, no /imports
      return json(res, 200, {
        serverId: CFG.serverId,
        preview: {
          videoId,
          url: previewUrl,
          title: 'Never Gonna Give You Up',
          artist: 'Rick Astley',
          durationSec: 213,
          thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
        },
      });
    }
    if (req.method === 'POST' && path === '/api/v1/imports') {
      const { title } = body as { title?: string };
      if (title === 'reject-me') return json(res, 400, { error: 'Control characters are not allowed' });
      return json(res, 202, {
        serverId: CFG.serverId,
        job: jobFixture({ title: title ?? 'Never Gonna Give You Up' }),
      });
    }
    if (req.method === 'GET' && path === '/api/v1/imports') {
      if (listMode === 'unavailable') {
        return json(res, 200, {
          serverId: CFG.serverId,
          available: false,
          unavailableReason: 'yt-dlp not found',
          jobs: [],
        });
      }
      if (listMode === 'wrong-server') {
        return json(res, 200, { serverId: 'someone-else', available: true, jobs: [] });
      }
      return json(res, 200, {
        serverId: CFG.serverId,
        available: true,
        jobs: [jobFixture({ state: 'ready', trackId: 'rick-never-gonna' })],
      });
    }
    return json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub failed to bind');
  CFG.port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err === undefined ? resolve() : reject(err))),
  );
});

beforeEach(() => {
  seen.length = 0;
  listMode = 'available';
});

describe('YouTube import client', () => {
  it('previews a link with the right POST body and bearer + server-id headers', async () => {
    const preview = await fetchImportPreview(CFG, previewUrl);

    expect(preview.videoId).toBe(videoId);
    expect(preview.title).toBe('Never Gonna Give You Up');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: { authorization: 'Bearer secret-token', serverId: CFG.serverId },
      body: { url: previewUrl },
    });
  });

  it('submits an import with the edited title/artist and keeps the returned job', async () => {
    const job = await submitImport(CFG, {
      url: previewUrl,
      title: 'Never Gonna Give You Up (Edited)',
      artist: 'Rick Astley',
    });

    expect(job.state).toBe('queued');
    expect(job.title).toBe('Never Gonna Give You Up (Edited)');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/imports',
      body: { url: previewUrl, title: 'Never Gonna Give You Up (Edited)', artist: 'Rick Astley' },
    });
  });

  it('lists jobs and GET also carries bearer + server-id headers', async () => {
    const res = await listImports(CFG);

    expect(res.available).toBe(true);
    expect(res.jobs[0]?.state).toBe('ready');
    expect(res.jobs[0]?.trackId).toBe('rick-never-gonna');
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: '/api/v1/imports',
      headers: { authorization: 'Bearer secret-token', serverId: CFG.serverId },
    });
  });

  it('surfaces available:false with the reason so the UI can disable the form', async () => {
    listMode = 'unavailable';
    const res = await listImports(CFG);

    expect(res.available).toBe(false);
    expect(res.unavailableReason).toBe('yt-dlp not found');
    expect(res.jobs).toEqual([]);
  });

  it('maps HTTP errors to the server {error} message, with status fallbacks', async () => {
    await expect(
      submitImport(CFG, { url: previewUrl, title: 'reject-me', artist: 'Rick Astley' }),
    ).rejects.toThrow('Control characters are not allowed');

    await expect(fetchImportPreview(CFG, `${previewUrl}&unpaired=1`)).rejects.toThrow(
      'bad token',
    );
    await expect(fetchImportPreview(CFG, `${previewUrl}&busy=1`)).rejects.toThrow(
      'Import queue is busy',
    );
    // Body without {error}: falls back to the status-specific hint.
    await expect(fetchImportPreview(CFG, `${previewUrl}&repair=1`)).rejects.toThrow(
      'Paired server changed — re-pair to continue.',
    );
    // 404 = the paired server predates the imports routes → explicit upgrade hint.
    await expect(fetchImportPreview(CFG, `${previewUrl}&legacy=1`)).rejects.toThrow(
      'too old for YouTube imports',
    );
  });

  it('drops a response whose serverId envelope does not match the paired server', async () => {
    // Client pinned to srv-1234, stub answers with someone-else → envelope mismatch.
    listMode = 'wrong-server';
    await expect(listImports(CFG)).rejects.toThrow('Server identity changed mid-request');
  });

  it('aborts an in-flight poll when the caller signals cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listImports(CFG, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
