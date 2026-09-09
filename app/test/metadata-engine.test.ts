import { beforeEach, expect, it, vi } from 'vitest';

import type { Manifest } from '@music-sync/shared';

const order: string[] = [];

const db = vi.hoisted(() => ({
  cfg: { host: 'h', port: 5300, token: 't', serverId: 'lib-a', name: 'A' },
  pending: [] as { trackId: string }[],
  local: [] as { id: string; contentKey: string; state: 'synced' }[],
  pushError: null as string | null,
  fetchManifest: vi.fn(),
  pushPendingMetadata: vi.fn(),
  upsertFromManifest: vi.fn(),
  deleteRows: vi.fn((ids: readonly string[]) => {
    const drop = new Set(ids);
    db.pending = db.pending.filter((edit) => !drop.has(edit.trackId));
    db.local = db.local.filter((track) => !drop.has(track.id));
  }),
}));

vi.mock('expo-file-system', () => ({ File: class { exists = false; delete(): void {} } }));
vi.mock('../src/db/schema', () => ({ runMigrations: vi.fn() }));
vi.mock('../src/player/queue', () => ({ refreshQueueMetadata: vi.fn(async () => undefined) }));
vi.mock('../src/sync/downloader', () => ({
  createDownloader: () => ({ enqueue: vi.fn(), reattach: async () => [] }),
}));
vi.mock('../src/sync/paths', () => ({
  ensureDirs: vi.fn(),
  resolveLocalUri: vi.fn(() => null),
  artworkDir: vi.fn(),
  musicDir: vi.fn(),
  pathToUri: vi.fn(),
  trackDestinationPath: vi.fn(),
  trackFileUri: vi.fn(),
}));
vi.mock('../src/sync/metadata', () => ({
  pushPendingMetadata: (...args: unknown[]) => db.pushPendingMetadata(...args),
}));
vi.mock('../src/api/client', () => ({
  fetchManifest: (...args: unknown[]) => db.fetchManifest(...args),
  authedFetch: vi.fn(),
  authHeaders: vi.fn(() => ({})),
  trackUrl: vi.fn(),
  artworkUrl: vi.fn(),
}));
vi.mock('../src/db/queries', () => ({
  getServerConfig: () => db.cfg,
  getLastEtag: () => null,
  listPendingMetadata: () => db.pending,
  listTracksForDiff: () => db.local,
  listByState: () => [],
  byId: () => null,
  upsertFromManifest: (...args: unknown[]) => db.upsertFromManifest(...args),
  deleteRows: (...args: unknown[]) => db.deleteRows(...(args as [readonly string[]])),
  setHeldDeletions: vi.fn(),
  setLastEtag: vi.fn(),
  setLastRev: vi.fn(),
  setLastSyncAt: vi.fn(),
  setStates: vi.fn(),
  setState: vi.fn(),
  markSynced: vi.fn(),
  incrementErrorCount: vi.fn(),
  resetFailedToQueued: vi.fn(),
  clearSyncState: vi.fn(),
  getHeldDeletions: vi.fn(() => null),
}));

import { runSync } from '../src/sync/engine';
import { useSyncStore } from '../src/store/syncStore';

const TRACK = {
  id: 'song-1',
  path: 'song-1.mp3',
  size: 1,
  mtimeMs: 1,
  contentKey: 'ck-1',
  format: 'mp3' as const,
  title: 'T',
  artist: 'A',
  album: 'Al',
  durationSec: 1,
};

function manifest(tracks: Manifest['tracks']): Manifest {
  return { v: 1, serverId: 'lib-a', rev: 1, generatedAt: '2026-01-01T00:00:00Z', tracks };
}

beforeEach(() => {
  order.length = 0;
  db.pending = [{ trackId: 'song-1' }];
  db.local = [{ id: 'song-1', contentKey: 'ck-1', state: 'synced' }];
  db.pushError = 'changed on the desktop';
  db.upsertFromManifest.mockClear();
  db.deleteRows.mockClear();
  db.pushPendingMetadata.mockImplementation(async () => {
    order.push('push');
    return db.pushError;
  });
  db.fetchManifest.mockImplementation(async () => {
    order.push('manifest');
    return { kind: 'ok', manifest: manifest([TRACK]), etag: 'e' };
  });
  useSyncStore.setState({
    status: 'idle',
    done: 0,
    total: 0,
    failed: 0,
    error: undefined,
    metadataError: undefined,
  });
});

it('uploads pending edits before the manifest and keeps a conflict on metadataError, not status=error', async () => {
  await runSync('manual');
  expect(order).toEqual(['push', 'manifest']);
  expect(db.upsertFromManifest).toHaveBeenCalled();
  expect(useSyncStore.getState()).toMatchObject({
    status: 'idle',
    error: undefined,
    metadataError: 'changed on the desktop',
  });
});

it('clears the stale metadata warning after a 404 whose track is deleted this pass', async () => {
  db.pushError = 'no longer on the desktop';
  db.fetchManifest.mockImplementation(async () => {
    order.push('manifest');
    return { kind: 'ok', manifest: manifest([]), etag: 'e' };
  });
  await runSync('manual');
  expect(db.deleteRows).toHaveBeenCalledWith(['song-1']);
  expect(db.pending).toEqual([]);
  expect(useSyncStore.getState()).toMatchObject({
    status: 'idle',
    error: undefined,
    metadataError: undefined,
  });
});
