import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Where the artwork store records each artwork's mime type (persisted with the index). */
export interface ArtworkMeta {
  setArtworkMime(artworkId: string, mime: string): void;
  getArtworkMime(artworkId: string): string | undefined;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/**
 * Content-addressed store for embedded artwork: bytes are written once to
 * <dataDir>/artwork/<sha1-of-bytes> and deduplicated across tracks.
 */
export class ArtworkStore {
  constructor(
    private readonly dir: string,
    private readonly meta: ArtworkMeta,
  ) {}

  /** Store artwork bytes (no-op if already present) and return the artworkId. */
  async put(data: Uint8Array, mime: string): Promise<string> {
    const artworkId = createHash('sha1').update(data).digest('hex');
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      await fsp.writeFile(this.filePath(artworkId), data, { flag: 'wx' });
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
    }
    this.meta.setArtworkMime(artworkId, mime);
    return artworkId;
  }

  filePath(artworkId: string): string {
    return path.join(this.dir, artworkId);
  }
}
