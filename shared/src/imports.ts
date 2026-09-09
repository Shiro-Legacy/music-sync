import { z } from 'zod';
import { TagStringSchema as tag } from './metadata.js';

export const ImportPreviewRequestSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>;

export const ImportRequestSchema = ImportPreviewRequestSchema.extend({ title: tag, artist: tag });
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportPreviewSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  url: z.string().url(),
  title: z.string(),
  artist: z.string(),
  durationSec: z.number().finite().positive(),
  thumbnailUrl: z.string().url().optional(),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export const ImportJobSchema = z.object({
  id: z.string().uuid(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  url: z.string().url(),
  title: z.string(),
  artist: z.string(),
  state: z.enum(['queued', 'downloading', 'processing', 'indexing', 'ready', 'failed']),
  progress: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  /** Set after indexing: sha1('YouTube/<videoId>.m4a'). Local DB state determines offline availability. */
  trackId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

export const ImportPreviewResponseSchema = z.object({ serverId: z.string(), preview: ImportPreviewSchema });
export const ImportJobResponseSchema = z.object({ serverId: z.string(), job: ImportJobSchema });
export const ImportListResponseSchema = z.object({
  serverId: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  jobs: z.array(ImportJobSchema),
});
export type ImportListResponse = z.infer<typeof ImportListResponseSchema>;
