import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexStore } from '../src/store.js';

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-store-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('IndexStore.flush', () => {
  it('serializes concurrent flushes and lands the latest rev', async () => {
    const file = path.join(dir, 'index-x.json');
    const store = new IndexStore(file, 10);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) {
      store.bumpRev();
      writes.push(store.flush());
    }
    await Promise.all(writes);
    const reloaded = new IndexStore(file);
    reloaded.load();
    expect(reloaded.rev).toBe(20);
    await expect(fsp.stat(`${file}.tmp`)).rejects.toThrow();
  });
});
