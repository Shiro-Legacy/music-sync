import type { LocalTrack, LocalTrackState, TrackEntry, TrackFormat } from '@music-sync/shared';

import { db } from './schema';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface TrackRow {
  id: string;
  path: string;
  contentKey: string;
  format: TrackFormat;
  title: string;
  artist: string;
  albumArtist: string | null;
  album: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  durationSec: number;
  size: number;
  artworkId: string | null;
  state: LocalTrackState;
  localUri: string | null;
  errorCount: number;
  updatedAt: number;
}

export interface ArtistSummary {
  artist: string;
  trackCount: number;
}

export interface AlbumSummary {
  /** Display/grouping artist: albumArtist when present, else track artist. */
  albumArtist: string;
  album: string;
  trackCount: number;
  artworkId: string | null;
  year: number | null;
}

export interface PlaylistSummary {
  id: number;
  name: string;
  trackCount: number;
  durationSec: number;
}

export interface StateCounts {
  queued: number;
  downloading: number;
  synced: number;
  failed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Track upserts / mutations
// ---------------------------------------------------------------------------

/**
 * Inserts or updates rows from manifest entries. Preserves local-only columns
 * (state, localUri, errorCount) on conflict; new rows start as 'queued'.
 */
export function upsertFromManifest(tracks: readonly TrackEntry[]): void {
  const now = Date.now();
  db.withTransactionSync(() => {
    const stmt = db.prepareSync(
      `INSERT INTO tracks (id, path, contentKey, format, title, artist, albumArtist, album,
                           trackNo, discNo, year, genre, durationSec, size, artworkId, state, updatedAt)
       VALUES ($id, $path, $contentKey, $format, $title, $artist, $albumArtist, $album,
               $trackNo, $discNo, $year, $genre, $durationSec, $size, $artworkId, 'queued', $updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         contentKey = excluded.contentKey,
         format = excluded.format,
         title = excluded.title,
         artist = excluded.artist,
         albumArtist = excluded.albumArtist,
         album = excluded.album,
         trackNo = excluded.trackNo,
         discNo = excluded.discNo,
         year = excluded.year,
         genre = excluded.genre,
         durationSec = excluded.durationSec,
         size = excluded.size,
         artworkId = excluded.artworkId,
         updatedAt = excluded.updatedAt`,
    );
    try {
      for (const t of tracks) {
        stmt.executeSync({
          $id: t.id,
          $path: t.path,
          $contentKey: t.contentKey,
          $format: t.format,
          $title: t.title,
          $artist: t.artist,
          $albumArtist: t.albumArtist ?? null,
          $album: t.album,
          $trackNo: t.trackNo ?? null,
          $discNo: t.discNo ?? null,
          $year: t.year ?? null,
          $genre: t.genre ?? null,
          $durationSec: t.durationSec,
          $size: t.size,
          $artworkId: t.artworkId ?? null,
          $updatedAt: now,
        });
      }
    } finally {
      stmt.finalizeSync();
    }
  });
}

export function setState(id: string, state: LocalTrackState, localUri?: string | null): void {
  if (localUri === undefined) {
    db.runSync('UPDATE tracks SET state = ?, updatedAt = ? WHERE id = ?', state, Date.now(), id);
  } else {
    db.runSync(
      'UPDATE tracks SET state = ?, localUri = ?, updatedAt = ? WHERE id = ?',
      state,
      localUri,
      Date.now(),
      id,
    );
  }
}

export function setStates(ids: readonly string[], state: LocalTrackState): void {
  if (ids.length === 0) return;
  const now = Date.now();
  // Re-queuing grants a fresh retry budget; errorCount gates the 3-attempt download cycle.
  const sql =
    state === 'queued'
      ? 'UPDATE tracks SET state = ?, errorCount = 0, updatedAt = ? WHERE id = ?'
      : 'UPDATE tracks SET state = ?, updatedAt = ? WHERE id = ?';
  db.withTransactionSync(() => {
    for (const id of ids) {
      db.runSync(sql, state, now, id);
    }
  });
}

export function markSynced(id: string, localUri: string): void {
  db.runSync(
    "UPDATE tracks SET state = 'synced', localUri = ?, errorCount = 0, updatedAt = ? WHERE id = ?",
    localUri,
    Date.now(),
    id,
  );
}

/** Returns the new error count. */
export function incrementErrorCount(id: string): number {
  db.runSync('UPDATE tracks SET errorCount = errorCount + 1, updatedAt = ? WHERE id = ?', Date.now(), id);
  const row = db.getFirstSync<{ errorCount: number }>('SELECT errorCount FROM tracks WHERE id = ?', id);
  return row?.errorCount ?? 0;
}

/** Moves failed rows back to queued with a clean error count. Returns their ids. */
export function resetFailedToQueued(): string[] {
  const rows = db.getAllSync<{ id: string }>("SELECT id FROM tracks WHERE state = 'failed'");
  db.runSync("UPDATE tracks SET state = 'queued', errorCount = 0, updatedAt = ? WHERE state = 'failed'", Date.now());
  return rows.map((r) => r.id);
}

export function deleteRows(ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.withTransactionSync(() => {
    for (const id of ids) {
      db.runSync('DELETE FROM tracks WHERE id = ?', id);
    }
  });
}

export function deleteAllTracks(): void {
  db.runSync('DELETE FROM tracks');
}

// ---------------------------------------------------------------------------
// Track reads
// ---------------------------------------------------------------------------

export function byId(id: string): TrackRow | null {
  return db.getFirstSync<TrackRow>('SELECT * FROM tracks WHERE id = ?', id);
}

/** Minimal view for computeSyncPlan. */
export function listTracksForDiff(): LocalTrack[] {
  return db.getAllSync<LocalTrack>('SELECT id, contentKey, state FROM tracks');
}

export function listArtists(): ArtistSummary[] {
  return db.getAllSync<ArtistSummary>(
    `SELECT artist, COUNT(*) AS trackCount
     FROM tracks GROUP BY artist
     ORDER BY artist COLLATE NOCASE`,
  );
}

export function listAlbums(artist?: string): AlbumSummary[] {
  const base = `SELECT COALESCE(albumArtist, artist) AS albumArtist, album,
                       COUNT(*) AS trackCount, MAX(artworkId) AS artworkId, MAX(year) AS year
                FROM tracks`;
  const tail = ` GROUP BY COALESCE(albumArtist, artist), album
                 ORDER BY albumArtist COLLATE NOCASE, album COLLATE NOCASE`;
  if (artist === undefined) {
    return db.getAllSync<AlbumSummary>(base + tail);
  }
  return db.getAllSync<AlbumSummary>(
    `${base} WHERE artist = $a OR albumArtist = $a ${tail}`,
    { $a: artist },
  );
}

export function listSongs(search?: string): TrackRow[] {
  if (search !== undefined && search.trim() !== '') {
    const like = `%${search.trim()}%`;
    return db.getAllSync<TrackRow>(
      `SELECT * FROM tracks
       WHERE title LIKE $q OR artist LIKE $q OR album LIKE $q
       ORDER BY title COLLATE NOCASE`,
      { $q: like },
    );
  }
  return db.getAllSync<TrackRow>('SELECT * FROM tracks ORDER BY title COLLATE NOCASE');
}

export function listSongsByArtist(artist: string): TrackRow[] {
  return db.getAllSync<TrackRow>(
    `SELECT * FROM tracks WHERE artist = $a OR albumArtist = $a
     ORDER BY album COLLATE NOCASE, COALESCE(discNo, 1), COALESCE(trackNo, 9999), title COLLATE NOCASE`,
    { $a: artist },
  );
}

export function albumTracks(albumArtist: string, album: string): TrackRow[] {
  return db.getAllSync<TrackRow>(
    `SELECT * FROM tracks
     WHERE COALESCE(albumArtist, artist) = $artist AND album = $album
     ORDER BY COALESCE(discNo, 1), COALESCE(trackNo, 9999), title COLLATE NOCASE`,
    { $artist: albumArtist, $album: album },
  );
}

export function listByState(state: LocalTrackState): TrackRow[] {
  return db.getAllSync<TrackRow>('SELECT * FROM tracks WHERE state = ? ORDER BY updatedAt', state);
}

export function countsByState(): StateCounts {
  const rows = db.getAllSync<{ state: LocalTrackState; n: number }>(
    'SELECT state, COUNT(*) AS n FROM tracks GROUP BY state',
  );
  const counts: StateCounts = { queued: 0, downloading: 0, synced: 0, failed: 0, total: 0 };
  for (const r of rows) {
    counts[r.state] = r.n;
    counts.total += r.n;
  }
  return counts;
}

export function syncedBytes(): number {
  const row = db.getFirstSync<{ bytes: number | null }>(
    "SELECT SUM(size) AS bytes FROM tracks WHERE state = 'synced'",
  );
  return row?.bytes ?? 0;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export function listPlaylists(): PlaylistSummary[] {
  return db.getAllSync<PlaylistSummary>(
    `SELECT p.id, p.name, COUNT(t.id) AS trackCount,
            COALESCE(SUM(t.durationSec), 0) AS durationSec
     FROM playlists p
     LEFT JOIN playlist_tracks pt ON pt.playlistId = p.id
     LEFT JOIN tracks t ON t.id = pt.trackId
     GROUP BY p.id, p.name
     ORDER BY p.updatedAt DESC, p.id DESC`,
  );
}

export function createPlaylist(name: string): number {
  const now = Date.now();
  const result = db.runSync(
    'INSERT INTO playlists (name, createdAt, updatedAt) VALUES (?, ?, ?)',
    name,
    now,
    now,
  );
  return result.lastInsertRowId;
}

export function renamePlaylist(id: number, name: string): void {
  db.runSync('UPDATE playlists SET name = ?, updatedAt = ? WHERE id = ?', name, Date.now(), id);
}

export function deletePlaylist(id: number): void {
  db.runSync('DELETE FROM playlists WHERE id = ?', id);
}

export function playlistTracks(id: number): TrackRow[] {
  return db.getAllSync<TrackRow>(
    `SELECT t.*
     FROM playlist_tracks pt
     JOIN tracks t ON t.id = pt.trackId
     WHERE pt.playlistId = ?
     ORDER BY pt.position`,
    id,
  );
}

export function addTracksToPlaylist(id: number, trackIds: readonly string[]): void {
  if (trackIds.length === 0) return;
  db.withTransactionSync(() => {
    const row = db.getFirstSync<{ maxPosition: number }>(
      `SELECT COALESCE(MAX(position), -1) AS maxPosition
       FROM playlist_tracks WHERE playlistId = ?`,
      id,
    );
    let position = (row?.maxPosition ?? -1) + 1;
    for (const trackId of trackIds) {
      const result = db.runSync(
        `INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position)
         VALUES (?, ?, ?)`,
        id,
        trackId,
        position,
      );
      if (result.changes > 0) position += 1;
    }
    db.runSync('UPDATE playlists SET updatedAt = ? WHERE id = ?', Date.now(), id);
  });
}

export function removeTrackFromPlaylist(id: number, trackId: string): void {
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId = ?', id, trackId);
    db.runSync('UPDATE playlists SET updatedAt = ? WHERE id = ?', Date.now(), id);
  });
}

// ---------------------------------------------------------------------------
// Key-value store
// ---------------------------------------------------------------------------

export function kvGet(key: string): string | null {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  db.runSync(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export function kvDelete(key: string): void {
  db.runSync('DELETE FROM kv WHERE key = ?', key);
}

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  serverId: string;
  name: string;
}

const KV_SERVER_CONFIG = 'serverConfig';
const KV_LAST_ETAG = 'lastEtag';
const KV_LAST_REV = 'lastRev';
const KV_LAST_SYNC_AT = 'lastSyncAt';
const KV_HELD_DELETIONS = 'heldDeletions';

export function getServerConfig(): ServerConfig | null {
  const raw = kvGet(KV_SERVER_CONFIG);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return null;
  }
}

export function setServerConfig(cfg: ServerConfig): void {
  kvSet(KV_SERVER_CONFIG, JSON.stringify(cfg));
}

export function getLastEtag(): string | null {
  return kvGet(KV_LAST_ETAG);
}

export function setLastEtag(etag: string | null): void {
  if (etag === null) kvDelete(KV_LAST_ETAG);
  else kvSet(KV_LAST_ETAG, etag);
}

export function getLastRev(): number | null {
  const raw = kvGet(KV_LAST_REV);
  return raw === null ? null : Number(raw);
}

export function setLastRev(rev: number): void {
  kvSet(KV_LAST_REV, String(rev));
}

export function getLastSyncAt(): number | null {
  const raw = kvGet(KV_LAST_SYNC_AT);
  return raw === null ? null : Number(raw);
}

export function setLastSyncAt(ms: number): void {
  kvSet(KV_LAST_SYNC_AT, String(ms));
}

export function getHeldDeletions(): string[] | null {
  const raw = kvGet(KV_HELD_DELETIONS);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export function setHeldDeletions(ids: string[] | null): void {
  if (ids === null || ids.length === 0) kvDelete(KV_HELD_DELETIONS);
  else kvSet(KV_HELD_DELETIONS, JSON.stringify(ids));
}

/** Wipes everything except the server pairing. */
export function clearSyncState(): void {
  deleteAllTracks();
  kvDelete(KV_LAST_ETAG);
  kvDelete(KV_LAST_REV);
  kvDelete(KV_LAST_SYNC_AT);
  kvDelete(KV_HELD_DELETIONS);
}
