import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PORT } from '@music-sync/shared';

/** Errors whose message is meant for the user's eyes (printed without a stack trace). */
export class ConfigError extends Error {}

/** Overridable so tests and smoke runs never touch the real ~/.music-sync. */
export const dataDir = process.env['MUSIC_SYNC_DATA_DIR'] ?? path.join(os.homedir(), '.music-sync');
export const configFilePath = path.join(dataDir, 'config.json');
/** Legacy single-library index location; migrated to libraryIndexPath('default') on v1→v2 upgrade. */
export const legacyIndexFilePath = path.join(dataDir, 'index.json');
export const artworkDir = path.join(dataDir, 'artwork');

/** Per-library index file. Keyed by library name so the files are human-debuggable. */
export function libraryIndexPath(libraryName: string): string {
  return path.join(dataDir, `index-${libraryName}.json`);
}

/** Per-library YouTube import job history. */
export function libraryImportsPath(libraryName: string): string {
  return path.join(dataDir, `imports-${libraryName}.json`);
}

const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const LibraryConfigSchema = z.object({
  /** CLI handle and index-file key; unique within the server. */
  name: z.string().regex(LIBRARY_NAME_RE),
  musicDir: z.string().min(1),
  /** Per-library bearer token: possessing it grants access to this library only. */
  token: z.string().min(1),
  /** Per-library identity the app pins at pairing time. */
  serverId: z.string().min(1),
});
export type LibraryConfig = z.infer<typeof LibraryConfigSchema>;

const ServerConfigSchema = z.object({
  v: z.literal(2),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  libraries: z.array(LibraryConfigSchema).min(1),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Pre-v2 config shape, accepted only to migrate it forward. */
const LegacyConfigSchema = z.object({
  musicDir: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string(),
});

export interface ConfigOverrides {
  musicDir?: string;
  /** Which library --music-dir applies to; required when more than one exists. */
  library?: string;
  port?: number;
}

export interface LoadedConfig {
  config: ServerConfig;
  firstRun: boolean;
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 24 random base62 characters from a CSPRNG. */
export function generateToken(length = 24): string {
  let token = '';
  for (let i = 0; i < length; i += 1) {
    token += TOKEN_ALPHABET.charAt(crypto.randomInt(TOKEN_ALPHABET.length));
  }
  return token;
}

function writeConfig(config: ServerConfig): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = `${configFilePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, configFilePath);
}

export function findLibrary(config: ServerConfig, name: string): LibraryConfig | undefined {
  return config.libraries.find((library) => library.name === name);
}

/**
 * Resolve which library a CLI command targets: an explicit name must exist;
 * with no name there must be exactly one library to fall back to.
 */
export function resolveLibrary(config: ServerConfig, name?: string): LibraryConfig {
  if (name !== undefined) {
    const library = findLibrary(config, name);
    if (library === undefined) {
      throw new ConfigError(
        `No library named '${name}'. Existing: ${config.libraries.map((l) => l.name).join(', ')}`,
      );
    }
    return library;
  }
  if (config.libraries.length === 1) return config.libraries[0] as LibraryConfig;
  throw new ConfigError(
    `This server has ${config.libraries.length} libraries — pass --library <name>.\n` +
      `Existing: ${config.libraries.map((l) => l.name).join(', ')}`,
  );
}

/** Mint and persist a new library. The caller prints pairing info. */
export function addLibrary(config: ServerConfig, name: string, musicDir: string): {
  config: ServerConfig;
  library: LibraryConfig;
} {
  if (!LIBRARY_NAME_RE.test(name)) {
    throw new ConfigError(`Invalid library name '${name}' (use lowercase letters, digits, dashes).`);
  }
  if (findLibrary(config, name) !== undefined) {
    throw new ConfigError(`A library named '${name}' already exists.`);
  }
  const library: LibraryConfig = {
    name,
    musicDir: path.resolve(musicDir),
    token: generateToken(),
    serverId: crypto.randomUUID(),
  };
  const next: ServerConfig = { ...config, libraries: [...config.libraries, library] };
  writeConfig(next);
  return { config: next, library };
}

/** Remove a library from the config. Music files and index file are left on disk. */
export function removeLibrary(config: ServerConfig, name: string): ServerConfig {
  if (findLibrary(config, name) === undefined) {
    throw new ConfigError(`No library named '${name}'.`);
  }
  if (config.libraries.length === 1) {
    throw new ConfigError('Cannot remove the last library — a server needs at least one.');
  }
  const next: ServerConfig = {
    ...config,
    libraries: config.libraries.filter((library) => library.name !== name),
  };
  writeConfig(next);
  return next;
}

/**
 * v1 (single-library) → v2: the sole library becomes 'default', keeping its
 * token and serverId verbatim so existing pairings survive, and the legacy
 * index.json moves to the per-library location.
 */
function migrateLegacyConfig(raw: unknown): ServerConfig {
  const legacy = LegacyConfigSchema.parse(raw);
  const config: ServerConfig = {
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
  };
  if (fs.existsSync(legacyIndexFilePath) && !fs.existsSync(libraryIndexPath('default'))) {
    fs.renameSync(legacyIndexFilePath, libraryIndexPath('default'));
  }
  writeConfig(config);
  return config;
}

/**
 * Load (or on first run, create) the persisted server config. CLI overrides for
 * musicDir/port are applied and persisted for subsequent runs.
 */
export function loadConfig(overrides: ConfigOverrides = {}): LoadedConfig {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(configFilePath)) {
    if (overrides.musicDir === undefined) {
      throw new ConfigError(
        'No configuration found — this looks like the first run.\n' +
          'Tell the server where your music lives:\n\n' +
          '  npm start --workspace server -- --music-dir "C:\\path\\to\\Music"\n',
      );
    }
    const config: ServerConfig = {
      v: 2,
      port: overrides.port ?? DEFAULT_PORT,
      name: os.hostname(),
      libraries: [
        {
          name: overrides.library ?? 'default',
          musicDir: path.resolve(overrides.musicDir),
          token: generateToken(),
          serverId: crypto.randomUUID(),
        },
      ],
    };
    writeConfig(config);
    return { config, firstRun: true };
  }

  let config: ServerConfig;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const isLegacy =
      typeof raw === 'object' && raw !== null && !('v' in (raw as Record<string, unknown>));
    config = isLegacy ? migrateLegacyConfig(raw) : ServerConfigSchema.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Could not read ${configFilePath}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Fix or delete the file and run again.',
    );
  }

  let changed = false;
  if (overrides.musicDir !== undefined) {
    const target = resolveLibrary(config, overrides.library);
    const resolved = path.resolve(overrides.musicDir);
    if (resolved !== target.musicDir) {
      config = {
        ...config,
        libraries: config.libraries.map((library) =>
          library.name === target.name ? { ...library, musicDir: resolved } : library,
        ),
      };
      changed = true;
    }
  }
  if (overrides.port !== undefined && overrides.port !== config.port) {
    config = { ...config, port: overrides.port };
    changed = true;
  }
  if (changed) writeConfig(config);

  return { config, firstRun: false };
}
