import { openDatabaseSync } from 'expo-sqlite';

export const db = openDatabaseSync('musicsync.db');

/**
 * Migrations, applied in order. `PRAGMA user_version` tracks how many have run.
 * Only ever append to this list.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL,
    contentKey TEXT NOT NULL,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    albumArtist TEXT,
    album TEXT NOT NULL,
    trackNo INTEGER,
    discNo INTEGER,
    year INTEGER,
    genre TEXT,
    durationSec REAL NOT NULL,
    size INTEGER NOT NULL,
    artworkId TEXT,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','downloading','synced','failed')),
    localUri TEXT,
    errorCount INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks (artist);
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks (albumArtist, album);
  CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks (title);
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE playlist_tracks (
    playlistId INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    trackId TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlistId, trackId)
  );
  CREATE INDEX idx_playlist_tracks_pos ON playlist_tracks(playlistId, position);
  `,
];

let migrated = false;

/** Idempotent; safe to call more than once per process. */
export function runMigrations(): void {
  if (migrated) return;
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    const next = version + 1;
    db.withTransactionSync(() => {
      db.execSync(sql);
      db.execSync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
  migrated = true;
}
