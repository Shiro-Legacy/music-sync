import { z } from 'zod';

/** Formats AVPlayer can play natively on iOS. Everything else is indexed but marked unsupported. */
export const PLAYABLE_FORMATS = ['mp3', 'flac', 'm4a', 'alac', 'aac', 'wav', 'aiff'] as const;

export const TrackFormatSchema = z.enum([...PLAYABLE_FORMATS, 'unsupported']);
export type TrackFormat = z.infer<typeof TrackFormatSchema>;

export const TrackEntrySchema = z.object({
  /** sha1(relative path, forward slashes) — stable identity per location in the library */
  id: z.string().min(1),
  /** relative path from the music root, forward slashes */
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  /** sha1(first 64KB + last 64KB + size) — identity of the bytes; changes when the file content changes */
  contentKey: z.string().min(1),
  format: TrackFormatSchema,
  title: z.string(),
  artist: z.string(),
  albumArtist: z.string().optional(),
  album: z.string(),
  trackNo: z.number().int().optional(),
  discNo: z.number().int().optional(),
  year: z.number().int().optional(),
  genre: z.string().optional(),
  durationSec: z.number().nonnegative(),
  /** sha1 of the embedded artwork bytes; fetch via /api/v1/artwork/:artworkId */
  artworkId: z.string().optional(),
  /**
   * EBU R128 integrated loudness in LUFS (ffmpeg `ebur128`). Absent until the server has
   * measured the file, or forever when ffmpeg is not installed. The app turns it into a
   * per-track playback gain so every song plays at the same level (see app/src/player/loudness.ts).
   */
  loudness: z.number().optional(),
  /** True peak in dBTP, measured together with `loudness`; caps the gain so boosts never clip. */
  truePeak: z.number().optional(),
});
export type TrackEntry = z.infer<typeof TrackEntrySchema>;

export const ManifestSchema = z.object({
  v: z.literal(1),
  /** random UUID minted at server first run; the app refuses manifests from a different server than it paired with */
  serverId: z.string().min(1),
  /** monotonic revision, bumped on any index change; doubles as the manifest ETag */
  rev: z.number().int().nonnegative(),
  generatedAt: z.string(),
  tracks: z.array(TrackEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
