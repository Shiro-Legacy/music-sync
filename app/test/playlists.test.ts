import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ seedSql: '' }));

vi.mock('expo-sqlite', async () => {
  const { DatabaseSync } = await import('node:sqlite');

  function bind(params: unknown[]): unknown[] {
    const only = params[0];
    return params.length === 1 && typeof only === 'object' && only !== null && !Array.isArray(only)
      ? [only]
      : params;
  }

  class ExpoSqliteMock {
    private readonly native = new DatabaseSync(':memory:');

    constructor(seedSql: string) {
      if (seedSql !== '') this.native.exec(seedSql);
    }

    execSync(sql: string): void {
      this.native.exec(sql);
    }

    getFirstSync<T>(sql: string, ...params: unknown[]): T | null {
      const row = (this.native.prepare(sql) as any).get(...bind(params));
      return (row as T | undefined) ?? null;
    }

    getAllSync<T>(sql: string, ...params: unknown[]): T[] {
      return (this.native.prepare(sql) as any).all(...bind(params)) as T[];
    }

    runSync(sql: string, ...params: unknown[]): { changes: number; lastInsertRowId: number } {
      const result = (this.native.prepare(sql) as any).run(...bind(params)) as {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
      };
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    }

    prepareSync(sql: string) {
      const statement = this.native.prepare(sql) as any;
      return {
        executeSync: (params: unknown) => statement.run(...bind([params])),
        finalizeSync: () => undefined,
      };
    }

    withTransactionSync<T>(task: () => T): T {
      this.native.exec('BEGIN');
      try {
        const result = task();
        this.native.exec('COMMIT');
        return result;
      } catch (error) {
        this.native.exec('ROLLBACK');
        throw error;
      }
    }
  }

  return {
    openDatabaseSync: () => new ExpoSqliteMock(mockState.seedSql),
  };
});

let schema!: typeof import('../src/db/schema');
let queries!: typeof import('../src/db/queries');

beforeAll(async () => {
  vi.resetModules();
  schema = await import('../src/db/schema');
  queries = await import('../src/db/queries');
  schema.runMigrations();
});

beforeEach(() => {
  schema.db.execSync('DELETE FROM playlist_tracks; DELETE FROM playlists; DELETE FROM tracks;');
  insertTrack('track-1', 'First', 61);
  insertTrack('track-2', 'Second', 125);
  insertTrack('track-3', 'Third', 240);
});

function insertTrack(id: string, title: string, durationSec: number): void {
  schema.db.runSync(
    `INSERT INTO tracks
      (id, path, contentKey, format, title, artist, albumArtist, album,
       trackNo, discNo, year, genre, durationSec, size, artworkId, state,
       localUri, errorCount, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `${id}.mp3`,
    `content-${id}`,
    'mp3',
    title,
    'Test Artist',
    null,
    'Test Album',
    null,
    null,
    null,
    null,
    durationSec,
    100,
    null,
    'synced',
    `file:///music/${id}.mp3`,
    0,
    Date.now(),
  );
}

describe('playlist database migration', () => {
  it('reaches schema version 2 and creates playlist tables', () => {
    const version = schema.db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    expect(version?.user_version).toBe(3);

    const tables = schema.db.getAllSync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('playlists', 'playlist_tracks')
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual(['playlist_tracks', 'playlists']);
  });
});

describe('playlist queries', () => {
  it('creates, renames, lists empty playlists, and totals tracks and duration', () => {
    const emptyId = queries.createPlaylist('Empty');
    const mixId = queries.createPlaylist('Mix');
    queries.addTracksToPlaylist(mixId, ['track-1', 'track-2']);

    queries.renamePlaylist(emptyId, 'Renamed');
    const rows = queries.listPlaylists();
    const empty = rows.find((playlist) => playlist.id === emptyId);
    const mix = rows.find((playlist) => playlist.id === mixId);

    expect(empty).toMatchObject({ id: emptyId, name: 'Renamed', trackCount: 0, durationSec: 0 });
    expect(mix).toMatchObject({ id: mixId, name: 'Mix', trackCount: 2, durationSec: 186 });
  });

  it('appends tracks in supplied order and ignores duplicate additions', () => {
    const id = queries.createPlaylist('Ordered');

    queries.addTracksToPlaylist(id, ['track-2', 'track-1']);
    queries.addTracksToPlaylist(id, ['track-3', 'track-1', 'track-2']);
    queries.addTracksToPlaylist(id, ['track-2']);

    expect(queries.playlistTracks(id).map((track) => track.id)).toEqual([
      'track-2',
      'track-1',
      'track-3',
    ]);
  });

  it('removes tracks, cascades sync deletions, and deletes playlist joins', () => {
    const id = queries.createPlaylist('Cleanup');
    queries.addTracksToPlaylist(id, ['track-1', 'track-2']);
    queries.removeTrackFromPlaylist(id, 'track-1');
    expect(queries.playlistTracks(id).map((track) => track.id)).toEqual(['track-2']);

    schema.db.runSync('DELETE FROM tracks WHERE id = ?', 'track-2');
    expect(queries.playlistTracks(id)).toEqual([]);
    expect(queries.listPlaylists().find((playlist) => playlist.id === id)).toMatchObject({
      trackCount: 0,
      durationSec: 0,
    });

    const deletedId = queries.createPlaylist('Delete me');
    queries.addTracksToPlaylist(deletedId, ['track-3']);
    queries.deletePlaylist(deletedId);
    const joins = schema.db.getFirstSync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlistId = ?',
      deletedId,
    );
    expect(joins?.count).toBe(0);
    expect(queries.listPlaylists().some((playlist) => playlist.id === deletedId)).toBe(false);
  });

  it('lists unplaylisted tracks in Songs-tab order across every sync state', () => {
    insertTrack('track-4', 'alpha', 30);
    schema.db.runSync("UPDATE tracks SET state = 'queued' WHERE id = ?", 'track-4');
    insertTrack('track-5', 'zeta', 45);
    schema.db.runSync("UPDATE tracks SET state = 'failed' WHERE id = ?", 'track-5');

    const first = queries.createPlaylist('First');
    const second = queries.createPlaylist('Second');
    queries.addTracksToPlaylist(first, ['track-1']);
    queries.addTracksToPlaylist(second, ['track-1', 'track-2']);

    expect(queries.listUnplaylistedTracks().map((track) => track.id)).toEqual([
      'track-4',
      'track-3',
      'track-5',
    ]);

    queries.deletePlaylist(first);
    expect(queries.listUnplaylistedTracks().map((track) => track.id)).toEqual([
      'track-4',
      'track-3',
      'track-5',
    ]);

    queries.deletePlaylist(second);
    expect(queries.listUnplaylistedTracks().map((track) => track.id)).toEqual([
      'track-4',
      'track-1',
      'track-2',
      'track-3',
      'track-5',
    ]);
  });

  it('bulk-adds 2000 tracks in one transaction without dropping or reordering', () => {
    const ids = Array.from({ length: 2000 }, (_, index) => {
      const id = `bulk-${String(index).padStart(4, '0')}`;
      insertTrack(id, id, 10);
      return id;
    });
    const playlistId = queries.createPlaylist('Bulk');
    queries.addTracksToPlaylist(playlistId, ids);
    queries.addTracksToPlaylist(playlistId, ids.slice(0, 10));

    expect(queries.playlistTracks(playlistId).map((track) => track.id)).toEqual(ids);
  });
});
