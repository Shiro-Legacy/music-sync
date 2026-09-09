import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import compress from '@fastify/compress';
import {
  apiRoutes,
  ImportJobResponseSchema,
  ImportListResponseSchema,
  ImportPreviewRequestSchema,
  ImportPreviewResponseSchema,
  ImportRequestSchema,
  TrackMetadataPatchSchema,
  TrackMetadataResponseSchema,
  type Manifest,
  type PingResponse,
  type TrackEntry,
  type TrackFormat,
  type TrackMetadataPatch,
} from '@music-sync/shared';
import { ImportError, type ImportService } from './imports.js';
import { MetadataConflictError, OverridesCorruptError } from './overrides.js';
import { YoutubeUrlError } from './youtube-url.js';

/** One isolated library exposed by the HTTP layer; getter injection keeps tests lightweight. */
export interface LibraryRuntime {
  name: string;
  serverId: string;
  tokenDigest: Buffer;
  getRev(): number;
  getTracks(): TrackEntry[];
  getTrackById(id: string): TrackEntry | undefined;
  getTrackFilePath(entry: TrackEntry): string;
  getArtwork(artworkId: string): { filePath: string; mime: string } | undefined;
  /** Sidecar title/artist override for the phone. Resolves the published entry, or undefined for an unknown id. */
  setTrackMetadata(id: string, patch: TrackMetadataPatch): Promise<TrackEntry | undefined>;
  imports?: ImportService;
}

/** Everything the HTTP layer needs from the rest of the server. */
export interface ServerDeps {
  name: string;
  version: string;
  libraries: LibraryRuntime[];
}

declare module 'fastify' {
  interface FastifyRequest {
    library: LibraryRuntime | null;
  }
}

const TRACK_CONTENT_TYPES: Record<TrackFormat, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  alac: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  unsupported: 'application/octet-stream',
};

const ARTWORK_ID_RE = /^[0-9a-f]{40}$/;

export function digestToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

function resolveLibrary(
  authorization: string | undefined,
  libraries: LibraryRuntime[],
): LibraryRuntime | undefined {
  const bearer = bearerToken(authorization);
  if (bearer === undefined) return undefined;
  const candidateDigest = digestToken(bearer);
  let match: LibraryRuntime | undefined;
  for (const library of libraries) {
    if (timingSafeEqual(candidateDigest, library.tokenDigest)) match ??= library;
  }
  return match;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLanIpv4(address: string): boolean {
  const match = IPV4_RE.exec(address);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((octet) => !Number.isInteger(octet) || octet > 255)) return false;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/** Loopback, RFC1918, link-local, IPv6 ULA/link-local, and IPv4-mapped forms thereof. */
export function isLanAddress(rawIp: string): boolean {
  const ip = (rawIp.split('%', 1)[0] ?? rawIp).toLowerCase(); // strip IPv6 zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return isLanIpv4(mapped[1] ?? '');
  if (ip.includes(':')) {
    if (ip === '::1') return true;
    if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique local
    return false;
  }
  return isLanIpv4(ip);
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parse a single-range 'bytes=' header; null means ignore it and serve the full body. */
export function parseRange(header: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';
  if (startStr === '' && endStr === '') return null;

  if (startStr === '') {
    // suffix range: last N bytes
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return 'unsatisfiable';
  if (endStr === '') return { start, end: size - 1 };

  const end = Number(endStr);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((raw) => {
    const tag = raw.trim();
    return tag === '*' || tag.replace(/^W\//i, '') === etag;
  });
}

function ifMatchSatisfied(header: string, contentKey: string): boolean {
  return header.split(',').some((raw) => {
    const tag = raw.trim();
    if (tag === '*') return true;
    // If-Match requires strong comparison (RFC 9110 §13.1.1): weak validators never match.
    if (/^W\//i.test(tag)) return false;
    return tag.replace(/^"|"$/g, '') === contentKey;
  });
}

function importService(library: LibraryRuntime): ImportService | undefined {
  return library.imports;
}

function sendImportError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ImportError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof YoutubeUrlError) return reply.code(400).send({ error: err.message });
  return reply.code(500).send({ error: 'import failed' });
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  if (deps.libraries.length === 0) throw new Error('At least one library is required');

  const app = Fastify({ logger: false, trustProxy: false });
  app.decorateRequest('library', null);

  // LAN guard on every route; bearer auth on /api/v1/* except ping (open for pairing diagnostics).
  app.addHook('onRequest', async (request, reply) => {
    if (!isLanAddress(request.ip)) {
      return reply.code(403).send({ error: 'forbidden: LAN clients only' });
    }
    const pathname = request.url.split('?', 1)[0] ?? request.url;
    if (pathname.startsWith('/api/v1/')) {
      request.library = resolveLibrary(request.headers.authorization, deps.libraries) ?? null;
      if (pathname !== apiRoutes.ping && request.library === null) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }
    return undefined;
  });

  // Compression only inside this scope (manifest/ping). Track and artwork bytes are
  // pre-compressed media, and gzip breaks Range semantics — they live outside it.
  await app.register(async (scope) => {
    await scope.register(compress);

    scope.get(apiRoutes.ping, async (request, reply) => {
      const library = request.library ?? deps.libraries[0]!;
      const body: PingResponse = {
        v: 1,
        serverId: library.serverId,
        name: deps.name,
        version: deps.version,
      };
      return reply.send(body);
    });

    scope.get(apiRoutes.manifest, async (request, reply) => {
      const library = request.library!;
      const etag = `"rev-${library.getRev()}"`;
      reply.header('etag', etag);
      if (etagMatches(request.headers['if-none-match'], etag)) {
        return reply.code(304).send();
      }
      const manifest: Manifest = {
        v: 1,
        serverId: library.serverId,
        rev: library.getRev(),
        generatedAt: new Date().toISOString(),
        tracks: library.getTracks(),
      };
      return reply.send(manifest);
    });

    await scope.register(async (imports) => {
      imports.addHook('preHandler', async (request, reply) => {
        const header = request.headers['x-musicsync-server-id'];
        const value = Array.isArray(header) ? header[0] : header;
        if (value !== request.library!.serverId) {
          return reply.code(409).send({ error: 'server identity mismatch' });
        }
        return undefined;
      });

      imports.post(apiRoutes.importPreview, async (request, reply) => {
        const service = importService(request.library!);
        if (service === undefined) {
          return reply.code(503).send({ error: 'YouTube imports are not configured' });
        }
        const body = ImportPreviewRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid request' });
        try {
          const preview = await service.preview(body.data.url);
          return reply.send(
            ImportPreviewResponseSchema.parse({ serverId: request.library!.serverId, preview }),
          );
        } catch (err) {
          return sendImportError(reply, err);
        }
      });

      imports.post(apiRoutes.imports, async (request, reply) => {
        const service = importService(request.library!);
        if (service === undefined) {
          return reply.code(503).send({ error: 'YouTube imports are not configured' });
        }
        const body = ImportRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid request' });
        try {
          const result = await service.submit(body.data);
          return reply.code(result.existingReady ? 200 : 202).send(
            ImportJobResponseSchema.parse({
              serverId: request.library!.serverId,
              job: result.job,
            }),
          );
        } catch (err) {
          return sendImportError(reply, err);
        }
      });

      imports.get(apiRoutes.imports, async (request, reply) => {
        const service = importService(request.library!);
        if (service === undefined) {
          return reply.send(
            ImportListResponseSchema.parse({
              serverId: request.library!.serverId,
              available: false,
              unavailableReason: 'YouTube imports are not configured',
              jobs: [],
            }),
          );
        }
        try {
          const listed = await service.list();
          return reply.send(
            ImportListResponseSchema.parse({
              serverId: request.library!.serverId,
              available: listed.available,
              ...(listed.unavailableReason !== undefined
                ? { unavailableReason: listed.unavailableReason }
                : {}),
              jobs: listed.jobs,
            }),
          );
        } catch (err) {
          return sendImportError(reply, err);
        }
      });

      // Phone-side title/artist edits. Same paired-identity guard as imports; lookup is by id only.
      imports.patch<{ Params: { id: string } }>(apiRoutes.trackMetadata(':id'), async (request, reply) => {
        const current = request.library!.getTrackById(request.params.id);
        if (current === undefined) return reply.code(404).send({ error: 'not found' });
        // The phone edited a specific file; a replaced or re-tagged file at the same path must not inherit the edit.
        const ifMatch = request.headers['if-match'];
        if (ifMatch === undefined) return reply.code(428).send({ error: 'If-Match with the content key is required' });
        if (!ifMatchSatisfied(ifMatch, current.contentKey)) return reply.code(412).send({ error: 'track content changed' });
        const body = TrackMetadataPatchSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid request' });
        try {
          const entry = await request.library!.setTrackMetadata(current.id, body.data);
          if (entry === undefined) return reply.code(404).send({ error: 'not found' });
          return reply.send(
            TrackMetadataResponseSchema.parse({
              serverId: request.library!.serverId,
              id: entry.id,
              title: entry.title,
              artist: entry.artist,
            }),
          );
        } catch (err) {
          if (err instanceof MetadataConflictError) return reply.code(412).send({ error: err.message });
          if (err instanceof OverridesCorruptError) return reply.code(503).send({ error: err.message });
          return reply.code(500).send({ error: 'could not save metadata' });
        }
      });
    });
  });

  app.get<{ Params: { id: string } }>(apiRoutes.track(':id'), async (request, reply) => {
    const library = request.library!;
    // Lookup by id only — a filesystem path is never derived from user input.
    const entry = library.getTrackById(request.params.id);
    if (entry === undefined) return reply.code(404).send({ error: 'unknown track' });

    const filePath = library.getTrackFilePath(entry);
    let size: number;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch {
      return reply.code(404).send({ error: 'track file missing' });
    }

    reply.header('accept-ranges', 'bytes');
    reply.header('etag', `"${entry.contentKey}"`);
    reply.header('content-type', TRACK_CONTENT_TYPES[entry.format]);

    const ifMatch = request.headers['if-match'];
    if (ifMatch !== undefined && !ifMatchSatisfied(ifMatch, entry.contentKey)) {
      return reply.code(412).send();
    }

    const rangeHeader = request.headers.range;
    if (rangeHeader !== undefined) {
      const range = parseRange(rangeHeader, size);
      if (range === 'unsatisfiable') {
        reply.header('content-range', `bytes */${size}`);
        return reply.code(416).send();
      }
      if (range !== null) {
        reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        reply.header('content-length', String(range.end - range.start + 1));
        return reply
          .code(206)
          .send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
      }
    }

    reply.header('content-length', String(size));
    return reply.send(fs.createReadStream(filePath));
  });

  app.get<{ Params: { artworkId: string } }>(
    apiRoutes.artwork(':artworkId'),
    async (request, reply) => {
      const { artworkId } = request.params;
      // Validate shape before the id goes anywhere near a path.
      if (!ARTWORK_ID_RE.test(artworkId)) return reply.code(404).send({ error: 'not found' });
      const artwork = request.library!.getArtwork(artworkId);
      if (artwork === undefined) return reply.code(404).send({ error: 'not found' });
      try {
        await fsp.access(artwork.filePath);
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
      reply.header('content-type', artwork.mime);
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(artwork.filePath));
    },
  );

  return app;
}
