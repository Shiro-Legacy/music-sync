import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestSchema, type TrackEntry } from '@music-sync/shared';
import { buildServer, digestToken } from '../src/http.js';
import { MetadataOverrides } from '../src/overrides.js';

const TOKEN = 'metadata-token-alice-0123456789';
const TOKEN_B = 'metadata-token-bob-9876543210';
const CONTENT_KEY = 'cafebabecafebabecafebabecafebabecafebabe';
const URL = '/api/v1/tracks/track-1/metadata';

const auth = { authorization: `Bearer ${TOKEN}` };
const paired = { ...auth, 'x-musicsync-server-id': 'srv-alice', 'if-match': `"${CONTENT_KEY}"` };

let dir: string;
let app: FastifyInstance;
let overrides: MetadataOverrides;
let rev = 5;

const entry: TrackEntry = {
  id: 'track-1',
  path: 'Artist/Album/song.mp3',
  size: 10,
  mtimeMs: 1,
  contentKey: CONTENT_KEY,
  format: 'mp3',
  title: 'Alice song',
  artist: 'Alice',
  album: 'Album',
  durationSec: 1,
};

function patch(body: unknown, headers: Record<string, string> = paired) {
  return app.inject({ method: 'PATCH', url: URL, headers, payload: body as object });
}

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-metadata-'));
  overrides = new MetadataOverrides(path.join(dir, 'overrides-alice.json'));
  overrides.load();
  app = await buildServer({
    name: 'TestPC',
    version: '0.0.0',
    libraries: [
      {
        name: 'alice',
        serverId: 'srv-alice',
        tokenDigest: digestToken(TOKEN),
        getRev: () => rev,
        getTracks: () => [overrides.apply(entry)],
        getTrackById: (id) => (id === entry.id ? entry : undefined),
        getTrackFilePath: () => path.join(dir, 'missing.mp3'),
        getArtwork: () => undefined,
        setTrackMetadata: async (id, body) => {
          if (id !== entry.id) return undefined;
          if (await overrides.set(entry.id, entry.contentKey, body)) rev += 1;
          return overrides.apply(entry);
        },
      },
      {
        name: 'bob',
        serverId: 'srv-bob',
        tokenDigest: digestToken(TOKEN_B),
        getRev: () => 0,
        getTracks: () => [],
        getTrackById: () => undefined,
        getTrackFilePath: () => '',
        getArtwork: () => undefined,
        setTrackMetadata: async () => undefined,
      },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('PATCH /api/v1/tracks/:id/metadata', () => {
  it('requires a token', async () => {
    const res = await app.inject({ method: 'PATCH', url: URL, payload: { title: 'x', artist: 'y' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires the paired server identity header', async () => {
    const { 'x-musicsync-server-id': _dropped, ...noServer } = paired;
    expect((await patch({ title: 'x', artist: 'y' }, noServer)).statusCode).toBe(409);
    const wrong = { ...paired, 'x-musicsync-server-id': 'srv-bob' };
    expect((await patch({ title: 'x', artist: 'y' }, wrong)).statusCode).toBe(409);
  });

  it('requires If-Match with the current content key', async () => {
    const { 'if-match': _dropped, ...noIfMatch } = paired;
    expect((await patch({ title: 'x', artist: 'y' }, noIfMatch)).statusCode).toBe(428);
    const stale = { ...paired, 'if-match': '"0000000000000000000000000000000000000000"' };
    expect((await patch({ title: 'x', artist: 'y' }, stale)).statusCode).toBe(412);
    const weak = { ...paired, 'if-match': `W/"${CONTENT_KEY}"` };
    expect((await patch({ title: 'x', artist: 'y' }, weak)).statusCode).toBe(412);
    expect(rev).toBe(5);
  });

  it('rejects invalid bodies', async () => {
    for (const body of [
      { title: '   ', artist: 'y' },
      { title: 'x' },
      { title: 'x', artist: 'y' },
      { title: 'x'.repeat(301), artist: 'y' },
      { title: 'x', artist: 'y', album: 'z' },
      { title: 'x', artist: 'y', path: '../../etc' },
      ['not', 'an', 'object'],
    ]) {
      expect((await patch(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(rev).toBe(5);
  });

  it('returns 404 for an unknown id and for another library token', async () => {
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tracks/nope/metadata',
      headers: paired,
      payload: { title: 'x', artist: 'y' },
    });
    expect(unknown.statusCode).toBe(404);
    const crossLibrary = await patch(
      { title: 'x', artist: 'y' },
      { ...paired, authorization: `Bearer ${TOKEN_B}`, 'x-musicsync-server-id': 'srv-bob' },
    );
    expect(crossLibrary.statusCode).toBe(404);
    expect(overrides.apply(entry)).toBe(entry);
  });

  it('accepts an edit, publishes it, bumps rev, persists, and repeats idempotently', async () => {
    const before = rev;
    const res = await patch({ title: '  New title ', artist: 'New artist' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: 'srv-alice', id: 'track-1', title: 'New title', artist: 'New artist' });
    expect(rev).toBe(before + 1);

    const manifest = await app.inject({ method: 'GET', url: '/api/v1/manifest', headers: auth });
    const body = ManifestSchema.parse(manifest.json());
    expect(body.rev).toBe(before + 1);
    expect(body.tracks[0]).toMatchObject({ title: 'New title', artist: 'New artist', contentKey: CONTENT_KEY });
    const stale = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest',
      headers: { ...auth, 'if-none-match': `"rev-${before}"` },
    });
    expect(stale.statusCode).toBe(200);

    const repeat = await patch({ title: 'New title', artist: 'New artist' });
    expect(repeat.statusCode).toBe(200);
    expect(rev).toBe(before + 1);

    const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'overrides-alice.json'), 'utf8'));
    expect(onDisk.byId['track-1']).toMatchObject({ contentKey: CONTENT_KEY, title: 'New title', artist: 'New artist' });
    expect(entry.title).toBe('Alice song'); // the indexed entry (and the file) are untouched
  });
});
