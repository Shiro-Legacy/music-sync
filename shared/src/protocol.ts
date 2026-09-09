import { z } from 'zod';

export const API_VERSION = 1;
export const DEFAULT_PORT = 5299;

export const apiRoutes = {
  ping: '/api/v1/ping',
  manifest: '/api/v1/manifest',
  imports: '/api/v1/imports',
  importPreview: '/api/v1/imports/preview',
  track: (id: string) => `/api/v1/tracks/${id}`,
  artwork: (artworkId: string) => `/api/v1/artwork/${artworkId}`,
} as const;

/** Payload encoded in the QR code the server prints for pairing. */
export const QrPayloadSchema = z.object({
  v: z.literal(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  token: z.string().min(1),
  name: z.string(),
});
export type QrPayload = z.infer<typeof QrPayloadSchema>;

export const PingResponseSchema = z.object({
  v: z.literal(1),
  serverId: z.string().min(1),
  name: z.string(),
  version: z.string(),
});
export type PingResponse = z.infer<typeof PingResponseSchema>;
