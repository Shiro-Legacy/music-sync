import { describe, expect, it } from 'vitest';
import {
  ImportRequestSchema,
  TrackMetadataPatchSchema,
  TrackMetadataResponseSchema,
  apiRoutes,
} from '../src/index.js';

describe('track metadata contract', () => {
  it('routes by id', () => {
    expect(apiRoutes.trackMetadata('abc')).toBe('/api/v1/tracks/abc/metadata');
  });

  it('trims and bounds title/artist, rejects extras and control characters', () => {
    expect(TrackMetadataPatchSchema.parse({ title: '  T ', artist: ' A' })).toEqual({ title: 'T', artist: 'A' });
    expect(TrackMetadataPatchSchema.safeParse({ title: ' ', artist: 'A' }).success).toBe(false);
    expect(TrackMetadataPatchSchema.safeParse({ title: 'T' }).success).toBe(false);
    expect(TrackMetadataPatchSchema.safeParse({ title: 'T\nX', artist: 'A' }).success).toBe(false);
    expect(TrackMetadataPatchSchema.safeParse({ title: 'x'.repeat(300), artist: 'A' }).success).toBe(true);
    expect(TrackMetadataPatchSchema.safeParse({ title: 'x'.repeat(301), artist: 'A' }).success).toBe(false);
    expect(TrackMetadataPatchSchema.safeParse({ title: 'T', artist: 'A', album: 'B' }).success).toBe(false);
  });

  it('shares the tag rules with imports unchanged', () => {
    const importOf = (title: string) =>
      ImportRequestSchema.safeParse({ url: 'https://youtu.be/x', title, artist: 'A' }).success;
    const patchOf = (title: string) => TrackMetadataPatchSchema.safeParse({ title, artist: 'A' }).success;
    for (const sample of [' ok ', '', 'x'.repeat(300), 'x'.repeat(301), 'bad']) {
      expect(patchOf(sample)).toBe(importOf(sample));
    }
  });

  it('response carries the accepted values', () => {
    expect(TrackMetadataResponseSchema.safeParse({ serverId: 's', id: 'i', title: 'T', artist: 'A' }).success).toBe(true);
    expect(TrackMetadataResponseSchema.safeParse({ serverId: 's', id: 'i', title: 'T' }).success).toBe(false);
  });
});
