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

export async function authedFetch(
  cfg: ServerEndpoint,
  path: string,
  options?: { timeoutMs?: number; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15000);
  try {
    return await fetch(`${baseUrl(cfg)}${path}`, {
      headers: { ...authHeaders(cfg), ...options?.extraHeaders },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
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
