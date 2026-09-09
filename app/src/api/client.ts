import {
  ManifestSchema,
  PingResponseSchema,
  apiRoutes,
  type Manifest,
  type PingResponse,
} from '@music-sync/shared';

/** Anything that can address the server. ServerConfig from the db satisfies this. */
export interface ServerEndpoint {
  host: string;
  port: number;
  token: string;
}

export function baseUrl(cfg: ServerEndpoint): string {
  return `http://${cfg.host}:${cfg.port}`;
}

export function authHeaders(cfg: ServerEndpoint): Record<string, string> {
  return { Authorization: `Bearer ${cfg.token}` };
}

export function trackUrl(cfg: ServerEndpoint, id: string): string {
  return `${baseUrl(cfg)}${apiRoutes.track(id)}`;
}

export function artworkUrl(cfg: ServerEndpoint, artworkId: string): string {
  return `${baseUrl(cfg)}${apiRoutes.artwork(artworkId)}`;
}

export interface AuthedFetchOptions {
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PATCH';
  /** JSON string body; sends Content-Type: application/json when present. */
  body?: string;
  /** External abort (e.g. screen blur) — aborts this request early. */
  signal?: AbortSignal;
}

export async function authedFetch(
  cfg: ServerEndpoint,
  path: string,
  options?: AuthedFetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15000);
  if (options?.signal?.aborted) controller.abort();
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const headers: Record<string, string> = { ...authHeaders(cfg), ...options?.extraHeaders };
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${baseUrl(cfg)}${path}`, {
      method: options?.method ?? 'GET',
      headers,
      body: options?.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function ping(cfg: ServerEndpoint, timeoutMs = 4000): Promise<PingResponse> {
  const res = await authedFetch(cfg, apiRoutes.ping, { timeoutMs });
  if (!res.ok) throw new Error(`Ping failed: HTTP ${res.status}`);
  return PingResponseSchema.parse(await res.json());
}

export type ManifestResult =
  | { kind: 'not-modified' }
  | { kind: 'ok'; manifest: Manifest; etag: string | null };

export async function fetchManifest(
  cfg: ServerEndpoint,
  lastEtag: string | null,
): Promise<ManifestResult> {
  const extraHeaders: Record<string, string> = {};
  if (lastEtag !== null) extraHeaders['If-None-Match'] = lastEtag;
  const res = await authedFetch(cfg, apiRoutes.manifest, { timeoutMs: 30000, extraHeaders });
  if (res.status === 304) return { kind: 'not-modified' };
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
  const manifest = ManifestSchema.parse(await res.json());
  return { kind: 'ok', manifest, etag: res.headers.get('etag') };
}
