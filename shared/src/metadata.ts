import { z } from 'zod';

/** A title or artist as the phone may submit it: trimmed, non-empty, bounded, printable. */
export const TagStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed');

/** PATCH /api/v1/tracks/:id/metadata body. Files on the desktop are never rewritten; the server keeps a sidecar override. */
export const TrackMetadataPatchSchema = z.object({ title: TagStringSchema, artist: TagStringSchema }).strict();
export type TrackMetadataPatch = z.infer<typeof TrackMetadataPatchSchema>;

/** PATCH response: the values this request accepted (trimmed). A concurrent later edit may already supersede them in the manifest. */
export const TrackMetadataResponseSchema = z.object({
  serverId: z.string(),
  id: z.string(),
  title: z.string(),
  artist: z.string(),
});
export type TrackMetadataResponse = z.infer<typeof TrackMetadataResponseSchema>;
