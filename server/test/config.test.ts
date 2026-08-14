import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let config!: typeof import('../src/config.js');

type LibraryConfig = import('../src/config.js').LibraryConfig;
type ServerConfig = import('../src/config.js').ServerConfig;

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join('/tmp', 'msync-config-'));
  vi.stubEnv('MUSIC_SYNC_DATA_DIR', dataDir);
  vi.resetModules();
  config = await import('../src/config.js');
});

beforeEach(async () => {
  for (const entry of await fsp.readdir(dataDir)) {
    await fsp.rm(path.join(dataDir, entry), { recursive: true, force: true });
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function library(name: string): LibraryConfig {
  return {
    name,
    musicDir: path.join(dataDir, 'music', name),
    token: `token-${name}`,
    serverId: `server-${name}`,
  };
}

function server(libraries: LibraryConfig[]): ServerConfig {
  return { v: 2, port: 5299, name: 'Test Mac', libraries };
}

describe('loadConfig migration', () => {
  it('migrates v1 config while preserving pairing and renaming the legacy index', async () => {
    const legacy = {
      musicDir: path.join(dataDir, 'music', 'default'),
      port: 5301,
      token: 'legacy-token-preserved',
      serverId: 'legacy-server-id-preserved',
      name: 'Legacy Mac',
    };
    const indexContents = '{"rev":7,"entries":{}}\n';
    await fsp.writeFile(config.configFilePath, `${JSON.stringify(legacy)}\n`, 'utf8');
    await fsp.writeFile(config.legacyIndexFilePath, indexContents, 'utf8');

    const loaded = config.loadConfig();

    expect(loaded.firstRun).toBe(false);
    expect(loaded.config).toEqual({
      v: 2,
      port: legacy.port,
      name: legacy.name,
      libraries: [
        {
          name: 'default',
          musicDir: legacy.musicDir,
          token: legacy.token,
          serverId: legacy.serverId,
        },
      ],
    });
    expect(await fsp.readFile(config.libraryIndexPath('default'), 'utf8')).toBe(indexContents);
    await expect(fsp.access(config.legacyIndexFilePath)).rejects.toThrow();

    const persisted = JSON.parse(await fsp.readFile(config.configFilePath, 'utf8')) as unknown;
    expect(persisted).toEqual(loaded.config);
  });
});

describe('addLibrary', () => {
  it('validates names, rejects duplicates, and persists a new library', async () => {
    const initial = server([library('jiaqi')]);

    for (const invalid of ['Alice', 'has space', 'under_score', '-leading']) {
      expect(() => config.addLibrary(initial, invalid, '/music')).toThrow(config.ConfigError);
    }
    expect(() => config.addLibrary(initial, 'jiaqi', '/music')).toThrow(
      'A library named \'jiaqi\' already exists.',
    );

    const result = config.addLibrary(initial, 'alice', '/music/alice');

    expect(result.config).toEqual({ ...initial, libraries: [...initial.libraries, result.library] });
    expect(result.library.name).toBe('alice');
    expect(result.library.musicDir).toBe(path.resolve('/music/alice'));
    expect(result.library.token).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(result.library.serverId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(initial.libraries).toHaveLength(1);

    const persisted = JSON.parse(await fsp.readFile(config.configFilePath, 'utf8')) as unknown;
    expect(persisted).toEqual(result.config);
  });
});

describe('removeLibrary', () => {
  it('guards against removing the last library', () => {
    const initial = server([library('solo')]);

    expect(() => config.removeLibrary(initial, 'solo')).toThrow(
      'Cannot remove the last library — a server needs at least one.',
    );
    expect(initial.libraries).toHaveLength(1);
  });

  it('removes an existing library when another remains', async () => {
    const initial = server([library('one'), library('two')]);

    const next = config.removeLibrary(initial, 'one');

    expect(next.libraries.map(({ name }) => name)).toEqual(['two']);
    const persisted = JSON.parse(await fsp.readFile(config.configFilePath, 'utf8')) as ServerConfig;
    expect(persisted).toEqual(next);
  });
});

describe('resolveLibrary', () => {
  it('requires an explicit name when there are zero libraries', () => {
    const empty = server([]);

    expect(() => config.resolveLibrary(empty)).toThrow(
      'This server has 0 libraries — pass --library <name>.',
    );
    expect(() => config.resolveLibrary(empty, 'missing')).toThrow("No library named 'missing'.");
  });

  it('returns the sole library with or without its name', () => {
    const sole = library('solo');
    const one = server([sole]);

    expect(config.resolveLibrary(one)).toBe(sole);
    expect(config.resolveLibrary(one, 'solo')).toBe(sole);
    expect(() => config.resolveLibrary(one, 'missing')).toThrow("No library named 'missing'.");
  });

  it('requires a name for multiple libraries and resolves valid names', () => {
    const alice = library('alice');
    const bob = library('bob');
    const many = server([alice, bob]);

    expect(() => config.resolveLibrary(many)).toThrow(
      'This server has 2 libraries — pass --library <name>.',
    );
    expect(config.resolveLibrary(many, 'alice')).toBe(alice);
    expect(config.resolveLibrary(many, 'bob')).toBe(bob);
    expect(() => config.resolveLibrary(many, 'missing')).toThrow("No library named 'missing'.");
  });
});
