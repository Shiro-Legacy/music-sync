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
  it('reaches schema version 4 and creates migration tables', () => {
    const version = schema.db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    expect(version?.user_version).toBe(4);

    const tables = schema.db.getAllSync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('playlists', 'playlist_tracks', 'pending_metadata')
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual(['pending_metadata', 'playlist_tracks', 'playlists']);
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

  it('copies a track to another playlist, keeps the source, and dedupes the destination', () => {
    const sourceId = queries.createPlaylist('Source');
    const destId = queries.createPlaylist('Dest');
    queries.addTracksToPlaylist(sourceId, ['track-1', 'track-2']);
    queries.addTracksToPlaylist(destId, ['track-1']);

    queries.addTracksToPlaylist(destId, ['track-2']);
    queries.addTracksToPlaylist(destId, ['track-1']);

    expect(queries.playlistTracks(sourceId).map((track) => track.id)).toEqual([
      'track-1',
      'track-2',
    ]);
    expect(queries.playlistTracks(destId).map((track) => track.id)).toEqual([
      'track-1',
      'track-2',
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

describe('track metadata editing', () => {
  const SERVER = 'server-a';

  /** Mirrors a paired library: serverConfig + trackLibraryServerId in kv. */
  function pairAs(serverId: string): void {
    queries.setServerConfig({ host: 'h', port: 1, token: 't', serverId, name: serverId });
    queries.kvSet('trackLibraryServerId', serverId);
  }

  function manifestTrack(id: string, title: string, artist: string, contentKey = `content-${id}`) {
    return {
      id,
      path: `${id}.mp3`,
      size: 100,
      mtimeMs: 1,
      contentKey,
      format: 'mp3' as const,
      title,
      artist,
      album: 'Test Album',
      durationSec: 60,
    };
  }

  beforeEach(() => {
    schema.db.runSync('DELETE FROM pending_metadata');
    pairAs(SERVER);
  });

  it('applies the edit to the track row immediately and records a pending outbox entry', () => {
    queries.saveTrackMetadata('track-1', '  Retitled Song  ', '  Fresh Artist ', SERVER);
    expect(queries.byId('track-1')).toMatchObject({ title: 'Retitled Song', artist: 'Fresh Artist' });
    expect(queries.listPendingMetadata(SERVER)).toEqual([
      {
        trackId: 'track-1',
        serverId: SERVER,
        contentKey: 'content-track-1',
        title: 'Retitled Song',
        artist: 'Fresh Artist',
        generation: 1,
      },
    ]);
  });

  it('keeps a pending edit when a newer manifest from the same server arrives', () => {
    queries.saveTrackMetadata('track-1', 'Edited', 'Edited Artist', SERVER);
    queries.upsertFromManifest([manifestTrack('track-1', 'Server Title', 'Server Artist')], SERVER);
    expect(queries.byId('track-1')).toMatchObject({ title: 'Edited', artist: 'Edited Artist' });
    expect(queries.listPendingMetadata(SERVER)).toHaveLength(1);
  });

  it('lets a manifest with a new contentKey win over a stale pending edit, which survives for retry', () => {
    queries.upsertFromManifest([manifestTrack('track-1', 'Server v1', 'Server Artist')], SERVER);
    queries.saveTrackMetadata('track-1', 'Local Edit', 'Local Artist', SERVER); // pending on content-track-1, gen 1

    // The file changed on the server: the pending edit targets the old bytes, so
    // the overlay must not apply and the manifest tags win the row.
    queries.upsertFromManifest([manifestTrack('track-1', 'Server v2', 'Server Artist 2', 'content-track-2')], SERVER);
    expect(queries.byId('track-1')).toMatchObject({
      title: 'Server v2',
      artist: 'Server Artist 2',
      contentKey: 'content-track-2',
    });
    expect(queries.listPendingMetadata(SERVER)).toEqual([
      expect.objectContaining({ contentKey: 'content-track-1', generation: 1, title: 'Local Edit' }),
    ]);

    // Editing again snapshots the new file and starts a fresh generation.
    queries.saveTrackMetadata('track-1', 'Local Edit 2', 'Local Artist 2', SERVER);
    expect(queries.listPendingMetadata(SERVER)).toEqual([
      expect.objectContaining({ contentKey: 'content-track-2', generation: 2, title: 'Local Edit 2' }),
    ]);
  });

  it('applies server metadata normally once the conflicting edit has been acknowledged', () => {
    queries.saveTrackMetadata('track-1', 'Local Edit', 'Local Artist', SERVER);
    const [pending] = queries.listPendingMetadata(SERVER);
    queries.acknowledgeMetadata(pending!);
    expect(queries.listPendingMetadata(SERVER)).toEqual([]);

    queries.upsertFromManifest([manifestTrack('track-1', 'Server Title', 'Server Artist')], SERVER);
    expect(queries.byId('track-1')).toMatchObject({ title: 'Server Title', artist: 'Server Artist' });
  });

  it('acks only the generation it was sent, so a late response cannot clear a newer edit', () => {
    queries.saveTrackMetadata('track-1', 'v1', 'A', SERVER);
    queries.saveTrackMetadata('track-1', 'v2', 'B', SERVER);
    const [pending] = queries.listPendingMetadata(SERVER);
    expect(pending?.generation).toBe(2);

    queries.acknowledgeMetadata({ ...pending!, generation: 1 }); // stale response
    const after = queries.listPendingMetadata(SERVER);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ generation: 2, title: 'v2' });

    queries.acknowledgeMetadata(after[0]!);
    expect(queries.listPendingMetadata(SERVER)).toEqual([]);
  });

  it('scopes pending edits to their serverId, so another server manifest clobbers that track', () => {
    queries.saveTrackMetadata('track-1', 'Local Edit', 'Local Artist', SERVER);
    queries.upsertFromManifest([manifestTrack('track-1', 'Other Server Title', 'Other Artist')], 'server-b');
    expect(queries.byId('track-1')).toMatchObject({ title: 'Other Server Title', artist: 'Other Artist' });
    expect(queries.listPendingMetadata(SERVER)).toHaveLength(1); // edit stays queued for its own server
    expect(queries.listPendingMetadata('server-b')).toEqual([]);

    expect(() => queries.saveTrackMetadata('track-1', 'X', 'Y', 'server-other')).toThrow(/Sync this library/);
  });

  it('adopts the manifest server as editable via trackLibraryServerId in kv', () => {
    queries.kvSet('trackLibraryServerId', ''); // not paired to server-m yet
    queries.setServerConfig({ host: 'h', port: 1, token: 't', serverId: 'server-m', name: 'm' });
    queries.upsertFromManifest([manifestTrack('track-1', 'Server Title', 'Server Artist')], 'server-m');
    expect(queries.kvGet('trackLibraryServerId')).toBe('server-m');

    queries.saveTrackMetadata('track-1', 'Edited', 'Ed Artist', 'server-m'); // guard now passes
    expect(queries.byId('track-1')).toMatchObject({ title: 'Edited', artist: 'Ed Artist' });
  });

  it('rejects blank or oversized metadata and leaves no partial outbox row', () => {
    expect(() => queries.saveTrackMetadata('track-1', '   ', 'Artist', SERVER)).toThrow();
    expect(() => queries.saveTrackMetadata('track-1', 'Title', '   ', SERVER)).toThrow();
    expect(() => queries.saveTrackMetadata('track-1', 'x'.repeat(301), 'Artist', SERVER)).toThrow();
    expect(() => queries.saveTrackMetadata('track-1', 'Title', 'x'.repeat(301), SERVER)).toThrow();
    expect(queries.listPendingMetadata(SERVER)).toEqual([]);

    queries.saveTrackMetadata('track-1', 'x'.repeat(300), 'Artist', SERVER); // 300 is the limit
    expect(queries.listPendingMetadata(SERVER)).toHaveLength(1);
    expect(queries.byId('track-1')?.title).toHaveLength(300);
  });

  it('cascades pending edits when the track is deleted, then refuses further edits to it', () => {
    queries.saveTrackMetadata('track-1', 'Edit', 'Artist', SERVER);
    expect(queries.listPendingMetadata(SERVER)).toHaveLength(1);
    queries.deleteRows(['track-1']);
    expect(queries.byId('track-1')).toBeNull();
    expect(queries.listPendingMetadata(SERVER)).toEqual([]);
    expect(() => queries.saveTrackMetadata('track-1', 'X', 'Y', SERVER)).toThrow(/no longer in the library/);
  });
});
