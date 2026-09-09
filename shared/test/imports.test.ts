import { describe, expect, it } from 'vitest';
import { ImportListResponseSchema, ImportPreviewRequestSchema, ImportRequestSchema } from '../src/imports.js';

describe('YouTube import contract', () => {
  const request = { url: 'https://youtu.be/abcdefghijk', title: 'A song', artist: 'An artist' };

  it('trims inputs and keeps user tags literal', () => {
    expect(ImportRequestSchema.parse({ ...request, title: '  100% %(title)s  ' }).title).toBe('100% %(title)s');
    expect(ImportPreviewRequestSchema.parse({ url: ` ${request.url} ` }).url).toBe(request.url);
  });

  it('rejects empty/oversized tags, control characters and arbitrary downloader options', () => {
    for (const title of ['', ' ', 'a'.repeat(301), 'a\nb', 'a\0b', 'a\x7fb']) {
      expect(ImportRequestSchema.safeParse({ ...request, title }).success).toBe(false);
    }
    expect(ImportRequestSchema.safeParse({ ...request, output: '/tmp/anything' }).success).toBe(false);
    expect(ImportPreviewRequestSchema.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('represents missing optional tools without breaking the library API', () => {
    expect(ImportListResponseSchema.parse({
      serverId: 'library-identity', available: false, unavailableReason: 'yt-dlp not installed', jobs: [],
    }).available).toBe(false);
  });
});
