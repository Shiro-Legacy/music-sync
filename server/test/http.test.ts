import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestSchema, PingResponseSchema, type TrackEntry } from '@music-sync/shared';
import { buildServer, digestToken, type ServerDeps } from '../src/http.js';

const TOKEN = 'testtokenABCDEF123456789';
const TOKEN_B = 'second-library-token-987654321';
const TRACK_SIZE = 4096;
const TRACK_SIZE_B = 2048;
const CONTENT_KEY = 'cafebabecafebabecafebabecafebabecafebabe';
const CONTENT_KEY_B = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const ARTWORK_ID = '0123456789abcdef0123456789abcdef01234567';

let dir: string;
let trackFile: string;
let trackFileB: string;
let artworkFile: string;
let artworkFileB: string;
let trackBody: Buffer;
let trackBodyB: Buffer;
let artworkBody: Buffer;
let artworkBodyB: Buffer;
let entry: TrackEntry;
let entryB: TrackEntry;
let app: FastifyInstance;

const auth = { authorization: `Bearer ${TOKEN}` };
const authB = { authorization: `Bearer ${TOKEN_B}` };

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-http-'));
  trackBody = Buffer.alloc(TRACK_SIZE);
  for (let i = 0; i < TRACK_SIZE; i += 1) trackBody[i] = (i * 7 + 3) % 256;
  trackBodyB = Buffer.alloc(TRACK_SIZE_B, 0xb2);
  artworkBody = Buffer.from('artwork from alice');
  artworkBodyB = Buffer.from('artwork from bob');
  trackFile = path.join(dir, 'alice-song.mp3');
  trackFileB = path.join(dir, 'bob-song.mp3');
  artworkFile = path.join(dir, 'alice-artwork.jpg');
  artworkFileB = path.join(dir, 'bob-artwork.jpg');
  await Promise.all([
    fsp.writeFile(trackFile, trackBody),
    fsp.writeFile(trackFileB, trackBodyB),
    fsp.writeFile(artworkFile, artworkBody),
    fsp.writeFile(artworkFileB, artworkBodyB),
  ]);

  entry = {
    id: 'track-1',
    path: 'Artist/Album/song.mp3',
    size: TRACK_SIZE,
    mtimeMs: 1111,
    contentKey: CONTENT_KEY,
    format: 'mp3',
    title: 'Alice song',
    artist: 'Alice',
    album: 'Album',
    durationSec: 12.5,
    artworkId: ARTWORK_ID,
  };
  entryB = {
    id: 'track-1',
    path: 'Other/Album/song.mp3',
    size: TRACK_SIZE_B,
    mtimeMs: 2222,
    contentKey: CONTENT_KEY_B,
    format: 'mp3',
    title: 'Bob song',
    artist: 'Bob',
    album: 'Album',
    durationSec: 8,
    artworkId: ARTWORK_ID,
  };

  const deps: ServerDeps = {
    name: 'TestPC',
    version: '9.9.9',
    libraries: [
      {
        name: 'alice',
        serverId: 'srv-alice',
        tokenDigest: digestToken(TOKEN),
        getRev: () => 5,
        getTracks: () => [entry],
        getTrackById: (id) => (id === entry.id ? entry : undefined),
        getTrackFilePath: () => trackFile,
        getArtwork: (id) =>
          id === ARTWORK_ID ? { filePath: artworkFile, mime: 'image/jpeg' } : undefined,
      },
      {
        name: 'bob',
        serverId: 'srv-bob',
        tokenDigest: digestToken(TOKEN_B),
        getRev: () => 9,
        getTracks: () => [entryB],
        getTrackById: (id) => (id === entryB.id ? entryB : undefined),
        getTrackFilePath: () => trackFileB,
        getArtwork: (id) =>
          id === ARTWORK_ID ? { filePath: artworkFileB, mime: 'image/png' } : undefined,
      },
    ],
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

  it('leaves ping open and defaults to the first library without a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ping' });
    expect(res.statusCode).toBe(200);
    const body = PingResponseSchema.parse(res.json());
    expect(body.serverId).toBe('srv-alice');
    expect(body.name).toBe('TestPC');
    expect(body.version).toBe('9.9.9');

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      headers: { authorization: 'Bearer unknown-token' },
    });
    expect(unknown.statusCode).toBe(200);
    expect(PingResponseSchema.parse(unknown.json()).serverId).toBe('srv-alice');
  });

  it('returns the matched library serverId when ping has a valid bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ping', headers: authB });
    expect(res.statusCode).toBe(200);
    expect(PingResponseSchema.parse(res.json()).serverId).toBe('srv-bob');
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
    expect(manifest.serverId).toBe('srv-alice');
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

describe('multi-library isolation', () => {
  it('serves each library manifest and colliding track id from its own token', async () => {
    const manifestA = await app.inject({ method: 'GET', url: '/api/v1/manifest', headers: auth });
    const manifestB = await app.inject({ method: 'GET', url: '/api/v1/manifest', headers: authB });

    expect(manifestA.statusCode).toBe(200);
    expect(manifestB.statusCode).toBe(200);
    const bodyA = ManifestSchema.parse(manifestA.json());
    const bodyB = ManifestSchema.parse(manifestB.json());
    expect(bodyA.serverId).toBe('srv-alice');
    expect(bodyA.rev).toBe(5);
    expect(bodyA.tracks).toHaveLength(1);
    expect(bodyA.tracks[0]!.title).toBe('Alice song');
    expect(bodyB.serverId).toBe('srv-bob');
    expect(bodyB.rev).toBe(9);
    expect(bodyB.tracks).toHaveLength(1);
    expect(bodyB.tracks[0]!.title).toBe('Bob song');

    const trackA = await app.inject({ method: 'GET', url: '/api/v1/tracks/track-1', headers: auth });
    const trackB = await app.inject({ method: 'GET', url: '/api/v1/tracks/track-1', headers: authB });
    expect(trackA.statusCode).toBe(200);
    expect(trackB.statusCode).toBe(200);
    expect(trackA.headers.etag).toBe(`"${CONTENT_KEY}"`);
    expect(trackB.headers.etag).toBe(`"${CONTENT_KEY_B}"`);
    expect(trackA.rawPayload.equals(trackBody)).toBe(true);
    expect(trackB.rawPayload.equals(trackBodyB)).toBe(true);
  });

  it('isolates artwork lookup by library and rejects unknown tokens', async () => {
    const artworkA = await app.inject({
      method: 'GET',
      url: `/api/v1/artwork/${ARTWORK_ID}`,
      headers: auth,
    });
    const artworkB = await app.inject({
      method: 'GET',
      url: `/api/v1/artwork/${ARTWORK_ID}`,
      headers: authB,
    });
    expect(artworkA.statusCode).toBe(200);
    expect(artworkB.statusCode).toBe(200);
    expect(artworkA.headers['content-type']).toBe('image/jpeg');
    expect(artworkB.headers['content-type']).toBe('image/png');
    expect(artworkA.rawPayload.equals(artworkBody)).toBe(true);
    expect(artworkB.rawPayload.equals(artworkBodyB)).toBe(true);

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/v1/artwork/${ARTWORK_ID}`,
      headers: { authorization: 'Bearer unknown-token' },
    });
    expect(unknown.statusCode).toBe(401);
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
      url: '/api/v1/artwork/fedcba9876543210fedcba9876543210fedcba98',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
