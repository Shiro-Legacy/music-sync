import {
  ImportJobResponseSchema,
  ImportListResponseSchema,
  ImportPreviewResponseSchema,
  apiRoutes,
  type ImportJob,
  type ImportListResponse,
  type ImportPreview,
} from '@music-sync/shared';

import { authedFetch, type ServerEndpoint } from '../api/client';

/**
 * What the import endpoints need beyond a plain server endpoint: the pinned
 * server id, echoed on every request as X-MusicSync-Server-Id. The pairing's
 * ServerConfig (db/queries) satisfies this structurally.
 */
export type ImportServer = ServerEndpoint & { serverId: string };

const PREVIEW_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 10_000;

function serverIdHeader(cfg: ImportServer): Record<string, string> {
  return { 'X-MusicSync-Server-Id': cfg.serverId };
}

/** Fallback text when the server returns an error without a useful {error} body. */
function statusFallback(status: number): string | null {
  switch (status) {
    case 401:
    case 403:
      return 'Pairing rejected — re-pair with your server.';
    case 409:
      return 'Paired server changed — re-pair to continue.';
    case 429:
      return 'Server is busy — try again shortly.';
    case 503:
      return 'Importing is temporarily unavailable on your server.';
    default:
      return null;
  }
}

async function parseError(res: Response): Promise<Error> {
  // An old still-running server has no /imports routes → 404. Say so plainly
  // instead of echoing an unhelpful 'not found'.
  if (res.status === 404) {
    return new Error('Your desktop server is too old for YouTube imports — update or restart it.');
  }
  let detail: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') detail = body.error;
  } catch {
    // non-JSON error body — fall through to the status fallback
  }
  return new Error(detail ?? statusFallback(res.status) ?? `Server error (HTTP ${res.status})`);
}

/** Guards every import response: the envelope must name the server we asked. */
function assertServer<T extends { serverId: string }>(envelope: T, cfg: ImportServer): T {
  if (envelope.serverId !== cfg.serverId) {
    throw new Error('Server identity changed mid-request — re-pair and try again.');
  }
  return envelope;
}

/** POST /imports/preview — fetch metadata for a YouTube link. */
export async function fetchImportPreview(
  cfg: ImportServer,
  url: string,
  signal?: AbortSignal,
): Promise<ImportPreview> {
  const res = await authedFetch(cfg, apiRoutes.importPreview, {
    method: 'POST',
    body: JSON.stringify({ url }),
    extraHeaders: serverIdHeader(cfg),
    timeoutMs: PREVIEW_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const parsed = ImportPreviewResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Server sent an invalid import preview.');
  return assertServer(parsed.data, cfg).preview;
}

/**
 * POST /imports — enqueue (or return the existing) import job. The server
 * dedupes: the same url+tags only creates a new job after a previous failure
 * or a missing final file, so this is also the retry action.
 */
export async function submitImport(
  cfg: ImportServer,
  req: { url: string; title: string; artist: string },
  signal?: AbortSignal,
): Promise<ImportJob> {
  const res = await authedFetch(cfg, apiRoutes.imports, {
    method: 'POST',
    body: JSON.stringify(req),
    extraHeaders: serverIdHeader(cfg),
    timeoutMs: SUBMIT_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const parsed = ImportJobResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Server sent an invalid import job.');
  return assertServer(parsed.data, cfg).job;
}

/** GET /imports — recent jobs for this library plus import availability. */
export async function listImports(cfg: ImportServer, signal?: AbortSignal): Promise<ImportListResponse> {
  const res = await authedFetch(cfg, apiRoutes.imports, {
    extraHeaders: serverIdHeader(cfg),
    timeoutMs: LIST_TIMEOUT_MS,
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const parsed = ImportListResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Server sent an invalid import list.');
  return assertServer(parsed.data, cfg);
}
