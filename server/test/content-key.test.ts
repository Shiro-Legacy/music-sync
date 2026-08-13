import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeContentKey } from '../src/indexer.js';

const CHUNK = 64 * 1024;

let dir: string;
let fileCounter = 0;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-ck-'));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function keyOf(buf: Buffer): Promise<string> {
  const file = path.join(dir, `f${fileCounter++}.bin`);
  await fsp.writeFile(file, buf);
  return computeContentKey(file);
}

/** Independent reimplementation of the recipe: sha1(head 64KB + tail 64KB + ascii size), whole file when <128KB. */
function referenceKey(buf: Buffer): string {
  const hash = createHash('sha1');
  if (buf.length < 2 * CHUNK) {
    hash.update(buf);
  } else {
    hash.update(buf.subarray(0, CHUNK));
    hash.update(buf.subarray(buf.length - CHUNK));
  }
  hash.update(String(buf.length), 'ascii');
  return hash.digest('hex');
}

function patternBuffer(length: number, seed = 0): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buf[i] = (i * 31 + seed) % 256;
  return buf;
}

describe('computeContentKey', () => {
  it('is deterministic and matches the documented recipe for large files', async () => {
    const buf = patternBuffer(200_000);
    const key1 = await keyOf(buf);
    const key2 = await keyOf(buf);
    expect(key1).toBe(key2);
    expect(key1).toBe(referenceKey(buf));
    expect(key1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes when a head byte changes', async () => {
    const original = patternBuffer(200_000);
    const mutated = Buffer.from(original);
    mutated[0] = (mutated[0]! + 1) % 256;
    expect(await keyOf(mutated)).not.toBe(await keyOf(original));
  });

  it('changes when a tail byte changes', async () => {
    const original = patternBuffer(200_000);
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1]! + 1) % 256;
    expect(await keyOf(mutated)).not.toBe(await keyOf(original));
  });

  it('changes when only the size changes (identical head and tail windows)', async () => {
    const head = patternBuffer(CHUNK, 1);
    const tail = patternBuffer(CHUNK, 2);
    const shortMiddle = patternBuffer(1024, 3);
    const longMiddle = Buffer.concat([shortMiddle, patternBuffer(1024, 3)]);
    const bufA = Buffer.concat([head, shortMiddle, tail]);
    const bufB = Buffer.concat([head, longMiddle, tail]);
    // Sanity: both files share the exact same first and last 64KB.
    expect(bufA.subarray(0, CHUNK).equals(bufB.subarray(0, CHUNK))).toBe(true);
    expect(bufA.subarray(bufA.length - CHUNK).equals(bufB.subarray(bufB.length - CHUNK))).toBe(true);
    expect(await keyOf(bufA)).not.toBe(await keyOf(bufB));
  });

  it('ignores middle-of-file changes on large files (only head, tail, size are hashed)', async () => {
    const original = patternBuffer(200_000);
    const mutated = Buffer.from(original);
    mutated[100_000] = (mutated[100_000]! + 1) % 256;
    expect(await keyOf(mutated)).toBe(await keyOf(original));
  });

  it('hashes files under 128KB as (whole file + size), no double-count', async () => {
    const buf = patternBuffer(1000);
    expect(await keyOf(buf)).toBe(referenceKey(buf));

    const mutated = Buffer.from(buf);
    mutated[500] = (mutated[500]! + 1) % 256; // middle byte matters for small files
    expect(await keyOf(mutated)).not.toBe(await keyOf(buf));
  });

  it('handles the exact 128KB boundary', async () => {
    const buf = patternBuffer(2 * CHUNK);
    expect(await keyOf(buf)).toBe(referenceKey(buf));
  });

  it('handles empty files', async () => {
    const buf = Buffer.alloc(0);
    expect(await keyOf(buf)).toBe(referenceKey(buf));
  });
});
