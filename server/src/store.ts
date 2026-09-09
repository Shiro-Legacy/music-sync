import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TrackEntrySchema, type TrackEntry } from '@music-sync/shared';

const PersistedIndexSchema = z.object({
  rev: z.number().int().nonnegative(),
  entries: z.record(z.string(), TrackEntrySchema),
  artworkMeta: z.record(z.string(), z.string()).default({}),
});

const PERSIST_DEBOUNCE_MS = 500;

/**
 * In-memory track index with debounced, atomic persistence to <dataDir>/index.json.
 * Entries are keyed by relative path (forward slashes); an id lookup map is kept in sync.
 */
export class IndexStore {
  private revValue = 0;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private exitHandlersInstalled = false;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly byPath = new Map<string, TrackEntry>();
  private readonly byId = new Map<string, TrackEntry>();
  private readonly artworkMeta = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = PERSIST_DEBOUNCE_MS,
  ) {}

  get rev(): number {
    return this.revValue;
  }

  get trackCount(): number {
    return this.byPath.size;
  }

  get(relPath: string): TrackEntry | undefined {
    return this.byPath.get(relPath);
  }

  getById(id: string): TrackEntry | undefined {
    return this.byId.get(id);
  }

  entries(): TrackEntry[] {
    return [...this.byPath.values()];
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }

  upsert(entry: TrackEntry): void {
    const previous = this.byPath.get(entry.path);
    if (previous !== undefined && previous.id !== entry.id) this.byId.delete(previous.id);
    this.byPath.set(entry.path, entry);
    this.byId.set(entry.id, entry);
  }

  remove(relPath: string): boolean {
    const previous = this.byPath.get(relPath);
    if (previous === undefined) return false;
    this.byPath.delete(relPath);
    this.byId.delete(previous.id);
    return true;
  }

  setArtworkMime(artworkId: string, mime: string): void {
    this.artworkMeta.set(artworkId, mime);
  }

  getArtworkMime(artworkId: string): string | undefined {
    return this.artworkMeta.get(artworkId);
  }

  bumpRev(): void {
    this.revValue += 1;
    this.dirty = true;
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = PersistedIndexSchema.parse(
        JSON.parse(fs.readFileSync(this.filePath, 'utf8')),
      );
      this.revValue = parsed.rev;
      for (const entry of Object.values(parsed.entries)) this.upsert(entry);
      for (const [artworkId, mime] of Object.entries(parsed.artworkMeta)) {
        this.artworkMeta.set(artworkId, mime);
      }
    } catch (err) {
      console.warn(
        `Ignoring unreadable index at ${this.filePath} (rebuilding from scratch): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Debounced persist: coalesces bursts of watcher events into one write. */
  schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.persistTimer.unref();
  }

  /** Serialized: a forced flush and the debounced one must not write the same .tmp concurrently. */
  flush(): Promise<void> {
    const next = this.flushChain.then(() => this.flushNow());
    this.flushChain = next;
    return next;
  }

  private async flushNow(): Promise<void> {
    if (!this.dirty) return;
    this.clearTimer();
    this.dirty = false;
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmpPath, this.serialize(), 'utf8');
      await fsp.rename(tmpPath, this.filePath);
    } catch (err) {
      this.dirty = true;
      console.warn(
        `Failed to persist index to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Synchronous flush for process-exit paths. */
  flushSync(): void {
    if (!this.dirty) return;
    this.clearTimer();
    this.dirty = false;
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, this.serialize(), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Exiting anyway; nothing sensible left to do.
    }
  }

  installExitHandlers(): void {
    if (this.exitHandlersInstalled) return;
    this.exitHandlersInstalled = true;
    const onSignal = (): void => {
      this.flushSync();
      process.exit(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.on('exit', () => {
      this.flushSync();
    });
  }

  private clearTimer(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
  }

  private serialize(): string {
    return JSON.stringify({
      rev: this.revValue,
      entries: Object.fromEntries(this.byPath),
      artworkMeta: Object.fromEntries(this.artworkMeta),
    });
  }
}
