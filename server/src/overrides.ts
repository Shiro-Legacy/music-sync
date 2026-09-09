import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TagStringSchema, type TrackEntry, type TrackMetadataPatch } from '@music-sync/shared';
import type { IndexStore } from './store.js';

const OverrideSchema = z.object({
  /** Bytes the edit was made against; the override is ignored once the file at this path changes. */
  contentKey: z.string().min(1),
  title: TagStringSchema,
  artist: TagStringSchema,
  updatedAt: z.string(),
});
type Override = z.infer<typeof OverrideSchema>;
const PersistedSchema = z.object({ v: z.literal(1), byId: z.record(z.string(), OverrideSchema) });

export class OverridesCorruptError extends Error {}
/** The track's bytes changed between the request's If-Match check and the serialized write. */
export class MetadataConflictError extends Error {}

/**
 * Sidecar title/artist overrides submitted from the phone. The audio files are never
 * rewritten, so the content key stays put and the phone does not re-download.
 *
 * Keyed by track id (location) and guarded by content key: a desktop re-tag, re-encode,
 * or replacement at the same path silently retires the override (the newer desktop edit
 * wins), and a desktop rename drops it like any other per-location state. A write is
 * published (visible to `apply`) only after it is on disk.
 */
export class MetadataOverrides {
  private byId: ReadonlyMap<string, Override> = new Map();
  private corrupt = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** A corrupt file is kept for the user to inspect, never overwritten; writes then fail loudly. */
  load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = PersistedSchema.parse(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      this.byId = new Map(Object.entries(parsed.byId));
    } catch {
      this.corrupt = true;
      console.warn(
        `${path.basename(this.filePath)} is corrupt; move it aside to accept metadata edits again`,
      );
    }
  }

  get isCorrupt(): boolean {
    return this.corrupt;
  }

  get size(): number {
    return this.byId.size;
  }

  /** The entry as published: file tags with the override laid over title/artist when the bytes still match. */
  apply(entry: TrackEntry): TrackEntry {
    const o = this.byId.get(entry.id);
    if (o === undefined || o.contentKey !== entry.contentKey) return entry;
    return { ...entry, title: o.title, artist: o.artist };
  }

  /**
   * Records an override for the given bytes and persists it. Writes are serialized;
   * `stillCurrent` runs inside that critical section so a file that changed while an
   * earlier write was in flight is rejected (MetadataConflictError) rather than relabeled.
   * Resolves true when the published values changed (caller bumps rev), false for a repeat.
   */
  set(
    id: string,
    contentKey: string,
    patch: TrackMetadataPatch,
    stillCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.corrupt) {
        throw new OverridesCorruptError(`${path.basename(this.filePath)} is corrupt; move it aside`);
      }
      if (!stillCurrent()) throw new MetadataConflictError('track content changed');
      const previous = this.byId.get(id);
      if (
        previous !== undefined &&
        previous.contentKey === contentKey &&
        previous.title === patch.title &&
        previous.artist === patch.artist
      ) {
        return false;
      }
      const next = new Map(this.byId);
      next.set(id, { contentKey, ...patch, updatedAt: new Date().toISOString() });
      await this.flush(next);
      this.byId = next;
      return true;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ponytail: rewrite the small per-library sidecar per edit; use SQLite if edit volume warrants it.
  private async flush(byId: ReadonlyMap<string, Override>): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(
      tmpPath,
      JSON.stringify({ v: 1, byId: Object.fromEntries(byId) }, null, 2),
      'utf8',
    );
    await fsp.rename(tmpPath, this.filePath);
  }
}

/**
 * The PATCH runtime step: record the override, make the rev bump durable, and only then
 * answer from the *current* index entry. The file may change during either await; an edit
 * made against bytes that are no longer there is a conflict, never a silent no-op.
 */
export async function setTrackMetadata(
  store: IndexStore,
  overrides: MetadataOverrides,
  id: string,
  patch: TrackMetadataPatch,
  log: (message: string) => void = () => undefined,
): Promise<TrackEntry | undefined> {
  const entry = store.getById(id);
  if (entry === undefined) return undefined;
  const stillCurrent = (): boolean => store.getById(id)?.contentKey === entry.contentKey;
  if (await overrides.set(entry.id, entry.contentKey, patch, stillCurrent)) {
    store.bumpRev();
    await store.flush(); // rev must be as durable as the sidecar, or a restart re-serves the old ETag
    log(`metadata override for ${entry.path} (rev ${store.rev})`);
  }
  const current = store.getById(id);
  if (current === undefined || current.contentKey !== entry.contentKey) {
    throw new MetadataConflictError('track content changed');
  }
  // This request's accepted snapshot, not the latest override: a concurrent edit may already have
  // superseded it, and the phone must ack the values it sent, not someone else's.
  return { ...current, ...patch };
}
