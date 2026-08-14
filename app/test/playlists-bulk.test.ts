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
});

function insertTrack(id: string, title: string, durationSec = 10): void {
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
    'Artist',
    null,
    'Album',
    null,
    null,
    null,
    null,
    durationSec,
    100,
    null,
    'synced',
    `file:///${id}.mp3`,
    0,
    Date.now(),
  );
}

function positionsOf(playlistId: number): number[] {
  return schema.db
    .getAllSync<{ position: number }>(
      'SELECT position FROM playlist_tracks WHERE playlistId = ? ORDER BY position',
      playlistId,
    )
    .map((row) => row.position);
}

describe('listUnplaylistedTracks', () => {
  it('returns an empty list for an empty library', () => {
    expect(queries.listUnplaylistedTracks()).toEqual([]);
  });

  it('orders by title case-insensitively, matching the Songs tab', () => {
    insertTrack('t-1', 'beta', 1);
    insertTrack('t-2', 'Alpha', 1);
    insertTrack('t-3', 'charlie', 1);
    insertTrack('t-4', 'alpha', 1);

    expect(queries.listUnplaylistedTracks().map((track) => track.title)).toEqual([
      'Alpha',
      'alpha',
      'beta',
      'charlie',
    ]);
  });
});

describe('addTracksToPlaylist position integrity', () => {
  it('assigns strictly increasing, gapless positions even with interleaved duplicates', () => {
    const id = queries.createPlaylist('P');
    insertTrack('a', 'A');
    insertTrack('b', 'B');
    insertTrack('c', 'C');
    insertTrack('d', 'D');
    insertTrack('e', 'E');

    queries.addTracksToPlaylist(id, ['a', 'b', 'c']);
    queries.addTracksToPlaylist(id, ['d', 'b', 'e']); // 'b' is a duplicate, 'd'/'e' are new

    expect(queries.playlistTracks(id).map((track) => track.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(positionsOf(id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('silently skips track ids that do not exist in tracks', () => {
    const id = queries.createPlaylist('P');
    insertTrack('a', 'A');
    insertTrack('b', 'B');

    queries.addTracksToPlaylist(id, ['a', 'ghost', 'b']);

    expect(queries.playlistTracks(id).map((track) => track.id)).toEqual(['a', 'b']);
    expect(positionsOf(id)).toEqual([0, 1]);
  });
});

describe('bulk add performance smoke', () => {
  it('bulk-adds 1500 tracks and re-adds them (all duplicates) within a generous bound', () => {
    const ids = Array.from({ length: 1500 }, (_, index) => {
      const trackId = `perf-${String(index).padStart(4, '0')}`;
      insertTrack(trackId, trackId, 1);
      return trackId;
    });

    const playlistId = queries.createPlaylist('Perf');

    const start = performance.now();
    queries.addTracksToPlaylist(playlistId, ids);
    queries.addTracksToPlaylist(playlistId, ids); // every row now a duplicate
    const elapsed = performance.now() - start;

    expect(queries.playlistTracks(playlistId).map((track) => track.id)).toEqual(ids);
    expect(positionsOf(playlistId)).toEqual(ids.map((_, index) => index));
    // Generous bound: catches accidental O(n^2) per-row regressions, not machine noise.
    expect(elapsed).toBeLessThan(5000);
  });
});
