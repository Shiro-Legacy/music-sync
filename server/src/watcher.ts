import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { ArtworkStore } from './artwork.js';
import { indexFile, relativeTrackPath, type MetadataParser } from './indexer.js';
import type { IndexStore } from './store.js';

export interface WatcherContext {
  store: IndexStore;
  artwork: ArtworkStore;
  parse?: MetadataParser;
  log?: (message: string) => void;
  /** Called after a file was (re-)indexed — hooks the background loudness pass. */
  onIndexed?: () => void;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/**
 * Live-watch the music folder: add/change re-indexes the file, unlink drops the
 * entry. Every applied change bumps rev and schedules a debounced persist.
 */
export function startWatcher(musicDir: string, context: WatcherContext): FSWatcher {
  const { store, artwork } = context;
  const log = context.log ?? ((message: string) => console.log(message));

  const watcher = watch(musicDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
    ignored: (watchedPath: string) => path.basename(watchedPath).startsWith('.'),
  });

  const reindex = (absPath: string): void => {
    void (async () => {
      const relPath = relativeTrackPath(musicDir, absPath);
      try {
        const outcome = await indexFile(musicDir, absPath, store, artwork, {
          ...(context.parse !== undefined ? { parse: context.parse } : {}),
        });
        if (outcome === 'indexed') {
          store.bumpRev();
          store.schedulePersist();
          log(`indexed ${relPath} (rev ${store.rev})`);
          context.onIndexed?.();
        }
      } catch (err) {
        if (isErrno(err, 'ENOENT')) {
          // File vanished between the event and the read: treat as an unlink.
          if (store.remove(relPath)) {
            store.bumpRev();
            store.schedulePersist();
            log(`removed ${relPath} (rev ${store.rev})`);
          }
          return;
        }
        log(`failed to index ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  watcher.on('add', reindex);
  watcher.on('change', reindex);
  watcher.on('unlink', (absPath: string) => {
    const relPath = relativeTrackPath(musicDir, absPath);
    if (store.remove(relPath)) {
      store.bumpRev();
      store.schedulePersist();
      log(`removed ${relPath} (rev ${store.rev})`);
    }
  });
  watcher.on('error', (err: unknown) => {
    log(`watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return watcher;
}
