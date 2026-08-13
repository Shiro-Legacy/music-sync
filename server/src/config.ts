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
export const indexFilePath = path.join(dataDir, 'index.json');
export const artworkDir = path.join(dataDir, 'artwork');

const ServerConfigSchema = z.object({
  musicDir: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export interface ConfigOverrides {
  musicDir?: string;
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
      musicDir: path.resolve(overrides.musicDir),
      port: overrides.port ?? DEFAULT_PORT,
      token: generateToken(),
      serverId: crypto.randomUUID(),
      name: os.hostname(),
    };
    writeConfig(config);
    return { config, firstRun: true };
  }

  let config: ServerConfig;
  try {
    config = ServerConfigSchema.parse(JSON.parse(fs.readFileSync(configFilePath, 'utf8')));
  } catch (err) {
    throw new ConfigError(
      `Could not read ${configFilePath}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Fix or delete the file and run again.',
    );
  }

  let changed = false;
  if (overrides.musicDir !== undefined) {
    const resolved = path.resolve(overrides.musicDir);
    if (resolved !== config.musicDir) {
      config = { ...config, musicDir: resolved };
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
