import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrackEntry } from '@music-sync/shared';
import { MetadataConflictError, MetadataOverrides, OverridesCorruptError, setTrackMetadata } from '../src/overrides.js';
import { IndexStore } from '../src/store.js';

const entry: TrackEntry = {
  id: 'id-1',
  path: 'a/b.mp3',
  size: 1,
  mtimeMs: 1,
  contentKey: 'key-1',
  format: 'mp3',
  title: 'File title',
  artist: 'File artist',
  album: '',
  durationSec: 1,
};

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-overrides-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('MetadataOverrides', () => {
  it('persists across instances and overlays only while the bytes match', async () => {
    const file = path.join(dir, 'nested', 'overrides-x.json');
    const a = new MetadataOverrides(file);
    a.load();
    expect(a.apply(entry)).toBe(entry);
    expect(await a.set('id-1', 'key-1', { title: 'T', artist: 'A' })).toBe(true);
    expect(await a.set('id-1', 'key-1', { title: 'T', artist: 'A' })).toBe(false);
    expect(await a.set('id-1', 'key-1', { title: 'T2', artist: 'A' })).toBe(true);

    const b = new MetadataOverrides(file);
    b.load();
    expect(b.apply(entry)).toMatchObject({ title: 'T2', artist: 'A', contentKey: 'key-1', id: 'id-1' });
    // Desktop re-tagged / replaced the file at the same path: the override retires.
    expect(b.apply({ ...entry, contentKey: 'key-2' }).title).toBe('File title');
    // A different track at another path is untouched.
    expect(b.apply({ ...entry, id: 'id-2' }).title).toBe('File title');
    await expect(fsp.stat(`${file}.tmp`)).rejects.toThrow();
  });

  it('serializes concurrent writes and keeps the last one', async () => {
    const file = path.join(dir, 'overrides-race.json');
    const s = new MetadataOverrides(file);
    await Promise.all([
      s.set('k', 'c', { title: '1', artist: 'a' }),
      s.set('k', 'c', { title: '2', artist: 'a' }),
      s.set('k', 'c', { title: '3', artist: 'a' }),
    ]);
    const reloaded = new MetadataOverrides(file);
    reloaded.load();
    expect(reloaded.apply({ ...entry, id: 'k', contentKey: 'c' }).title).toBe('3');
  });

  it('keeps a corrupt file untouched and refuses writes', async () => {
    const file = path.join(dir, 'overrides-bad.json');
    await fsp.writeFile(file, '{not json');
    const s = new MetadataOverrides(file);
    s.load();
    expect(s.isCorrupt).toBe(true);
    await expect(s.set('k', 'c', { title: 'x', artist: 'y' })).rejects.toBeInstanceOf(OverridesCorruptError);
    expect(await fsp.readFile(file, 'utf8')).toBe('{not json');
    expect(s.apply(entry)).toBe(entry);
  });

  it('reverts memory when the write fails', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    await fsp.writeFile(blocker, 'file');
    const s = new MetadataOverrides(path.join(blocker, 'overrides.json'));
    await expect(s.set('id-1', 'key-1', { title: 'x', artist: 'y' })).rejects.toThrow();
    expect(s.apply(entry)).toBe(entry);
  });
});

describe('MetadataOverrides guards', () => {
  it('rejects a write whose bytes changed while queued, without touching disk or memory', async () => {
    const file = path.join(dir, 'overrides-guard.json');
    const s = new MetadataOverrides(file);
    await s.set('id-1', 'key-1', { title: 'first', artist: 'a' });
    await expect(
      s.set('id-1', 'key-1', { title: 'second', artist: 'a' }, () => false),
    ).rejects.toBeInstanceOf(MetadataConflictError);
    expect(s.apply(entry).title).toBe('first');
    expect(s.size).toBe(1);
    const reloaded = new MetadataOverrides(file);
    reloaded.load();
    expect(reloaded.apply(entry).title).toBe('first');
  });

  it('does not publish a value before it is on disk', async () => {
    const blocker = path.join(dir, 'blocker-file');
    await fsp.writeFile(blocker, 'file');
    const s = new MetadataOverrides(path.join(blocker, 'overrides.json'));
    const pending = s.set('id-1', 'key-1', { title: 'x', artist: 'y' });
    expect(s.apply(entry)).toBe(entry); // mid-flight: still the file tags
    await expect(pending).rejects.toThrow();
    expect(s.size).toBe(0);
  });
});

describe('setTrackMetadata runtime step', () => {
  it('answers from the current entry and conflicts when the file changed during the flush', async () => {
    const store = new IndexStore(path.join(dir, 'index-rt.json'));
    const overrides = new MetadataOverrides(path.join(dir, 'overrides-rt.json'));
    store.upsert(entry);
    expect(await setTrackMetadata(store, overrides, 'missing', { title: 'x', artist: 'y' })).toBeUndefined();

    const ok = await setTrackMetadata(store, overrides, 'id-1', { title: 'T', artist: 'A' });
    expect(ok).toMatchObject({ id: 'id-1', title: 'T', artist: 'A', contentKey: 'key-1' });
    const revAfter = store.rev;
    expect(revAfter).toBe(1);

    // Desktop replaces the file while the index flush is in flight.
    const original = store.flush.bind(store);
    store.flush = async () => {
      store.upsert({ ...entry, contentKey: 'key-2', title: 'Desktop title' });
      await original();
    };
    await expect(
      setTrackMetadata(store, overrides, 'id-1', { title: 'T2', artist: 'A' }),
    ).rejects.toBeInstanceOf(MetadataConflictError);
    expect(overrides.apply(store.getById('id-1')!).title).toBe('Desktop title');
    expect(store.rev).toBe(revAfter + 1); // the rev bump is harmless: the manifest changed anyway
  });

  it('acks the values this request accepted even when a newer edit lands during the flush', async () => {
    const store = new IndexStore(path.join(dir, 'index-race.json'));
    const overrides = new MetadataOverrides(path.join(dir, 'overrides-race.json'));
    store.upsert(entry);
    const original = store.flush.bind(store);
    store.flush = async () => {
      await overrides.set('id-1', 'key-1', { title: 'newer', artist: 'B' });
      await original();
    };
    const first = await setTrackMetadata(store, overrides, 'id-1', { title: 'older', artist: 'A' });
    expect(first).toMatchObject({ title: 'older', artist: 'A', contentKey: 'key-1' });
    expect(overrides.apply(entry)).toMatchObject({ title: 'newer', artist: 'B' });
  });
});
