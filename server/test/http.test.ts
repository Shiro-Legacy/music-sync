import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestSchema, PingResponseSchema, type TrackEntry } from '@music-sync/shared';
import { buildServer, type ServerDeps } from '../src/http.js';

const TOKEN = 'testtokenABCDEF123456789';
const TRACK_SIZE = 4096;
const CONTENT_KEY = 'cafebabecafebabecafebabecafebabecafebabe';

let dir: string;
let trackFile: string;
let trackBody: Buffer;
let entry: TrackEntry;
let app: FastifyInstance;

const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-http-'));
  trackBody = Buffer.alloc(TRACK_SIZE);
  for (let i = 0; i < TRACK_SIZE; i += 1) trackBody[i] = (i * 7 + 3) % 256;
  trackFile = path.join(dir, 'song.mp3');
  await fsp.writeFile(trackFile, trackBody);

  entry = {
    id: 'track-1',
    path: 'Artist/Album/song.mp3',
    size: TRACK_SIZE,
    mtimeMs: 1111,
    contentKey: CONTENT_KEY,
    format: 'mp3',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    durationSec: 12.5,
  };

  const deps: ServerDeps = {
    serverId: 'srv-test',
    name: 'TestPC',
    version: '9.9.9',
    token: TOKEN,
    getRev: () => 5,
    getTracks: () => [entry],
    getTrackById: (id) => (id === entry.id ? entry : undefined),
    getTrackFilePath: () => trackFile,
    getArtwork: () => undefined,
  };
  app = await buildServer(deps);
});

afterAll(async () => {
  await app.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('auth', () => {
  it('rejects API routes without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/manifest' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest',
      headers: { authorization: 'Bearer definitely-not-the-token00' },
    });
    expect(res.statusCode).toBe(401);

    const trackRes = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    expect(trackRes.statusCode).toBe(401);
  });

  it('leaves ping open for pairing diagnostics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    expect(res.statusCode).toBe(200);
    const body = PingResponseSchema.parse(res.json());
    expect(body.serverId).toBe('srv-test');
    expect(body.name).toBe('TestPC');
    expect(body.version).toBe('9.9.9');
  });
});

describe('LAN guard', () => {
  it('rejects public IPv4 clients on every route, token or not', async () => {
    const ping = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      remoteAddress: '8.8.8.8',
    });
    expect(ping.statusCode).toBe(403);

    const manifest = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest',
      headers: auth,
      remoteAddress: '203.0.113.9',
    });
    expect(manifest.statusCode).toBe(403);
  });

  it('accepts private, link-local, and IPv4-mapped private addresses', async () => {
    for (const remoteAddress of ['192.168.1.20', '10.1.2.3', '172.31.0.7', '169.254.9.9', '::1', '::ffff:10.1.2.3']) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/ping', remoteAddress });
      expect(res.statusCode, `remoteAddress ${remoteAddress}`).toBe(200);
    }
  });

  it('rejects an IPv4-mapped public address', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      remoteAddress: '::ffff:8.8.8.8',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('manifest', () => {
  it('serves a valid manifest with a strong rev ETag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/manifest', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"rev-5"');
    const manifest = ManifestSchema.parse(res.json());
    expect(manifest.serverId).toBe('srv-test');
    expect(manifest.rev).toBe(5);
    expect(manifest.tracks).toHaveLength(1);
    expect(manifest.tracks[0]!.id).toBe('track-1');
  });

  it('returns 304 with an empty body on ETag match', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest',
      headers: { ...auth, 'if-none-match': '"rev-5"' },
    });
    expect(res.statusCode).toBe(304);
    expect(res.payload).toBe('');
  });

  it('serves the full manifest when the ETag is stale', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest',
      headers: { ...auth, 'if-none-match': '"rev-4"' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('tracks', () => {
  it('serves the full file with 200 and the right headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tracks/track-1', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers.etag).toBe(`"${CONTENT_KEY}"`);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-length']).toBe(String(TRACK_SIZE));
    expect(res.rawPayload.equals(trackBody)).toBe(true);
  });

  it('serves bytes=0-1023 as a 206 with the exact slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, range: 'bytes=0-1023' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-1023/${TRACK_SIZE}`);
    expect(res.headers['content-length']).toBe('1024');
    expect(res.rawPayload.equals(trackBody.subarray(0, 1024))).toBe(true);
  });

  it('serves an open-ended range bytes=4000-', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, range: 'bytes=4000-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4000-4095/${TRACK_SIZE}`);
    expect(res.rawPayload.equals(trackBody.subarray(4000))).toBe(true);
  });

  it('serves a suffix range bytes=-100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, range: 'bytes=-100' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 3996-4095/${TRACK_SIZE}`);
    expect(res.rawPayload.equals(trackBody.subarray(TRACK_SIZE - 100))).toBe(true);
  });

  it('returns 416 with bytes */size for an unsatisfiable range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, range: `bytes=${TRACK_SIZE}-` },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${TRACK_SIZE}`);
  });

  it('returns 412 when If-Match does not match the contentKey', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, 'if-match': '"0000000000000000000000000000000000000000"' },
    });
    expect(res.statusCode).toBe(412);
  });

  it('serves normally when If-Match matches', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, 'if-match': `"${CONTENT_KEY}"` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 412 for a weak If-Match validator even with the right contentKey (strong comparison)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/track-1',
      headers: { ...auth, 'if-match': `W/"${CONTENT_KEY}"` },
    });
    expect(res.statusCode).toBe(412);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tracks/no-such-track',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('artwork', () => {
  it('rejects malformed artwork ids before any path use', async () => {
    for (const bad of ['nothex', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', 'deadbeef']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/artwork/${bad}`,
        headers: auth,
      });
      expect(res.statusCode, `artworkId ${bad}`).toBe(404);
    }
  });

  it('returns 404 for a well-formed but unknown artwork id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/artwork/0123456789abcdef0123456789abcdef01234567',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
