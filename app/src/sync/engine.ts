import { apiRoutes, computeSyncPlan, type Manifest } from '@music-sync/shared';
import { File } from 'expo-file-system';

import { artworkUrl, authHeaders, authedFetch, fetchManifest, trackUrl } from '../api/client';
import {
  byId,
  clearSyncState,
  deleteRows,
  getHeldDeletions,
  getLastEtag,
  getServerConfig,
  incrementErrorCount,
  listByState,
  listPendingMetadata,
  listTracksForDiff,
  markSynced,
  resetFailedToQueued,
  setHeldDeletions,
  setLastEtag,
  setLastRev,
  setLastSyncAt,
  setState,
  setStates,
  upsertFromManifest,
  type ServerConfig,
  type TrackRow,
} from '../db/queries';
import { runMigrations } from '../db/schema';
import { refreshQueueMetadata } from '../player/queue';
import { pushPendingMetadata } from './metadata';
import { useSyncStore } from '../store/syncStore';
import { createDownloader, type Downloader } from './downloader';
import {
  artworkDir,
  ensureDirs,
  musicDir,
  pathToUri,
  resolveLocalUri,
  trackDestinationPath,
  trackFileUri,
} from './paths';

export type SyncTrigger = 'foreground' | 'manual' | 'network' | 'background';

const MAX_ERRORS = 3;

let syncInFlight = false;
/** Track ids with a live native download task. */
const activeDownloads = new Set<string>();
let downloader: Downloader | null = null;

function getDownloader(): Downloader {
  if (downloader === null) {
    downloader = createDownloader({
      onDone: handleDownloadDone,
      onError: handleDownloadError,
    });
  }
  return downloader;
}

// ---------------------------------------------------------------------------
// Download completion handling
// ---------------------------------------------------------------------------

function bumpProgress(kind: 'ok' | 'failed'): void {
  useSyncStore.setState((s) => ({
    done: s.done + 1,
    failed: kind === 'failed' ? s.failed + 1 : s.failed,
  }));
}

function finishIfDrained(): void {
  if (activeDownloads.size > 0) return;
  setLastSyncAt(Date.now());
  useSyncStore.setState((s) => ({
    status: s.status === 'error' || s.status === 'unpaired' ? s.status : 'idle',
  }));
}

function handleDownloadDone(id: string, location: string, bytesDownloaded: number): void {
  activeDownloads.delete(id);
  const row = byId(id);
  if (row === null) {
    // Row vanished (deleted while downloading) — drop the file.
    try {
      const orphan = new File(pathToUri(location));
      if (orphan.exists) orphan.delete();
    } catch {
      // ignore
    }
    finishIfDrained();
    return;
  }

  const file = new File(pathToUri(location));
  const actualSize = file.exists ? file.size : bytesDownloaded;
  if (file.exists && actualSize === row.size) {
    markSynced(id, file.uri);
    bumpProgress('ok');
    if (row.artworkId !== null) {
      void ensureArtwork(row.artworkId);
    }
  } else {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
    failOrRetry(row, `size mismatch (expected ${row.size}, got ${actualSize})`);
  }
  finishIfDrained();
}

function handleDownloadError(id: string, error: string, _errorCode: number): void {
  activeDownloads.delete(id);
  const row = byId(id);
  if (row !== null) {
    failOrRetry(row, error);
  }
  finishIfDrained();
}

function failOrRetry(row: TrackRow, reason: string): void {
  const errors = incrementErrorCount(row.id);
  if (errors < MAX_ERRORS) {
    const cfg = getServerConfig();
    if (cfg !== null) {
      enqueueDownload(cfg, row);
      return;
    }
  }
  console.warn(`[sync] track ${row.id} failed permanently: ${reason}`);
  setState(row.id, 'failed');
  bumpProgress('failed');
}

function enqueueDownload(cfg: ServerConfig, row: TrackRow): void {
  activeDownloads.add(row.id);
  setState(row.id, 'downloading');
  getDownloader().enqueue({
    id: row.id,
    url: trackUrl(cfg, row.id),
    destination: trackDestinationPath(row),
    headers: authHeaders(cfg),
  });
}

async function ensureArtwork(artworkId: string): Promise<void> {
  try {
    const file = new File(artworkDir(), artworkId);
    if (file.exists) return;
    const cfg = getServerConfig();
    if (cfg === null) return;
    const res = await authedFetch(cfg, apiRoutes.artwork(artworkId), { timeoutMs: 15000 });
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    file.write(bytes);
  } catch {
    // Artwork is cosmetic — never fail a sync over it.
  }
}

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

function applyMove(fromId: string, toId: string): 'moved' | 'needs-download' {
  const fromRow = byId(fromId);
  const toRow = byId(toId);
  if (toRow === null) return 'needs-download';
  const srcUri = fromRow === null ? null : resolveLocalUri(fromRow);
  if (fromRow === null || srcUri === null) {
    deleteRows(fromRow === null ? [] : [fromId]);
    return 'needs-download';
  }
  try {
    const src = new File(srcUri);
    if (!src.exists) throw new Error('source file missing');
    const dest = new File(trackFileUri(toRow));
    if (dest.exists && dest.uri !== src.uri) dest.delete();
    src.moveSync(dest);
    markSynced(toId, dest.uri);
    deleteRows([fromId]);
    return 'moved';
  } catch {
    deleteRows([fromId]);
    return 'needs-download';
  }
}

function applyDeletions(ids: readonly string[]): void {
  for (const id of ids) {
    const row = byId(id);
    const uri = row === null ? null : resolveLocalUri(row);
    if (uri !== null) {
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        // best effort — the row goes away regardless
      }
    }
  }
  deleteRows([...ids]);
}

/** Confirms and applies deletions that a previous sync held back (mass-delete guard). */
export function applyHeldDeletions(): void {
  const held = getHeldDeletions();
  if (held !== null) applyDeletions(held);
  setHeldDeletions(null);
}

/** Discards held deletions without applying them (they may be re-proposed next sync). */
export function dismissHeldDeletions(): void {
  setHeldDeletions(null);
}

/** Enqueues every row still in 'queued' state that has no live download task. */
function drainPendingQueue(cfg: ServerConfig): void {
  for (const row of listByState('queued')) {
    if (!activeDownloads.has(row.id)) {
      enqueueDownload(cfg, row);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Startup: ensure dirs + backup exclusion, reattach to background downloads
 * that survived a relaunch, and reset stuck 'downloading' rows to 'queued'.
 */
export async function initSyncEngine(): Promise<void> {
  runMigrations();
  ensureDirs();
  const survivors = await getDownloader().reattach();
  for (const id of survivors) activeDownloads.add(id);
  const stuck = listByState('downloading')
    .filter((row) => !activeDownloads.has(row.id))
    .map((row) => row.id);
  setStates(stuck, 'queued');
  if (activeDownloads.size > 0) {
    useSyncStore.setState({
      status: 'syncing',
      total: activeDownloads.size,
      done: 0,
      failed: 0,
      error: undefined,
    });
  }
}

/** Moves failed tracks back to the queue and kicks a sync. */
export async function retryFailed(): Promise<void> {
  resetFailedToQueued();
  await runSync('manual');
}

/**
 * One full sync pass. Single-flight: concurrent calls are dropped.
 */
export async function runSync(trigger: SyncTrigger): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    runMigrations();
    const cfg = getServerConfig();
    if (cfg === null) {
      useSyncStore.setState({ status: 'unpaired', error: undefined });
      return;
    }
    useSyncStore.setState({ status: 'checking', error: undefined, metadataError: undefined });
    ensureDirs();

    const metadataError = await pushPendingMetadata(cfg);
    if (getServerConfig()?.serverId !== cfg.serverId) throw new Error('Pairing changed during sync.');
    const result = await fetchManifest(cfg, getLastEtag());
    if (getServerConfig()?.serverId !== cfg.serverId) throw new Error('Pairing changed during sync.');
    if (result.kind === 'not-modified') {
      // Library unchanged — still drain anything that never finished.
      drainPendingQueue(cfg);
      startProgress();
      useSyncStore.setState({ metadataError: metadataError ?? undefined });
      return;
    }

    const manifest: Manifest = result.manifest;
    if (manifest.serverId !== cfg.serverId) {
      throw new Error(
        `Server identity mismatch: paired with ${cfg.serverId}, manifest is from ${manifest.serverId}. Re-pair to continue.`,
      );
    }

    const playable = manifest.tracks.filter((t) => t.format !== 'unsupported');
    const local = listTracksForDiff();
    const plan = computeSyncPlan(playable, local);

    // 1. Metadata for every (playable) manifest track.
    upsertFromManifest(playable, cfg.serverId);
    void refreshQueueMetadata().catch((error) => console.warn('[player] metadata refresh failed', error));

    // 2. Rename rescues — move local files instead of re-downloading.
    const rescueFailures: string[] = [];
    for (const mv of plan.toMove) {
      if (applyMove(mv.fromId, mv.toId) === 'needs-download') {
        rescueFailures.push(mv.toId);
      }
    }

    // 3. Deletions — held back for user confirmation on mass deletes.
    if (plan.deletionsHeld) {
      setHeldDeletions(plan.toDelete);
    } else {
      applyDeletions(plan.toDelete);
      setHeldDeletions(null);
    }

    // 4. Downloads.
    const toDownload = [...plan.toDownload, ...rescueFailures];
    setStates(toDownload, 'queued');
    for (const id of toDownload) {
      if (activeDownloads.has(id)) continue;
      const row = byId(id);
      if (row !== null) enqueueDownload(cfg, row);
    }
    drainPendingQueue(cfg);

    setLastEtag(result.etag ?? String(manifest.rev));
    setLastRev(manifest.rev);
    startProgress();
    useSyncStore.setState({
      metadataError: listPendingMetadata(cfg.serverId).length > 0 ? metadataError ?? undefined : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useSyncStore.setState({ status: 'error', error: message });
  } finally {
    syncInFlight = false;
  }
}

function startProgress(): void {
  const total = activeDownloads.size;
  if (total > 0) {
    useSyncStore.setState({ status: 'syncing', total, done: 0, failed: 0 });
  } else {
    setLastSyncAt(Date.now());
    useSyncStore.setState({ status: 'idle', total: 0, done: 0, failed: 0 });
  }
}

/**
 * Deletes all downloaded music, artwork and local rows. Keeps the pairing.
 * Caller is responsible for stopping playback first.
 */
export function wipeLocalLibrary(): void {
  try {
    const music = musicDir();
    if (music.exists) music.delete();
  } catch {
    // ignore
  }
  try {
    const artwork = artworkDir();
    if (artwork.exists) artwork.delete();
  } catch {
    // ignore
  }
  clearSyncState();
  ensureDirs();
  useSyncStore.setState({ status: 'idle', total: 0, done: 0, failed: 0, error: undefined, metadataError: undefined });
}
