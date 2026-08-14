import { beforeAll, describe, expect, it, vi } from 'vitest';

const V1_SEED = `
  CREATE TABLE tracks (
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
    state TEXT NOT NULL DEFAULT 'queued',
    localUri TEXT,
    errorCount INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  INSERT INTO tracks
    (id, path, contentKey, format, title, artist, album, durationSec, size, updatedAt)
    VALUES ('legacy-track', 'legacy.mp3', 'legacy-content', 'mp3', 'Legacy song', 'Legacy artist', 'Legacy album', 99, 100, 123);
  INSERT INTO kv (key, value) VALUES ('serverConfig', '{"host":"legacy"}');
  PRAGMA user_version = 1;
`;

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

beforeAll(async () => {
  mockState.seedSql = V1_SEED;
  vi.resetModules();
  schema = await import('../src/db/schema');
  schema.runMigrations();
});

describe('playlist migration from schema version 1', () => {
  it('preserves existing tracks and key-value data while reaching version 2', () => {
    const version = schema.db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    expect(version?.user_version).toBe(2);

    const track = schema.db.getFirstSync<{ id: string; title: string }>(
      'SELECT id, title FROM tracks WHERE id = ?',
      'legacy-track',
    );
    expect(track).toEqual({ id: 'legacy-track', title: 'Legacy song' });

    const pairing = schema.db.getFirstSync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      'serverConfig',
    );
    expect(pairing?.value).toBe('{"host":"legacy"}');

    const foreignKeys = schema.db.getFirstSync<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(foreignKeys?.foreign_keys).toBe(1);

    const tables = schema.db.getAllSync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('playlists', 'playlist_tracks')
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual(['playlist_tracks', 'playlists']);
  });
});
