import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@music-sync/shared';
import { ArtworkStore } from './artwork.js';
import {
  artworkDir,
  ConfigError,
  dataDir,
  indexFilePath,
  loadConfig,
  type ConfigOverrides,
} from './config.js';
import { buildServer, type ServerDeps } from './http.js';
import { scanLibrary } from './indexer.js';
import { printPairing } from './pairing.js';
import { IndexStore } from './store.js';
import { startWatcher } from './watcher.js';

interface CliOptions {
  musicDir?: string;
  port?: number;
  pair: boolean;
  status: boolean;
  help: boolean;
}

const USAGE = `music-sync server

Usage:
  npm start --workspace server -- [options]

Options:
  --music-dir <path>  Music folder to index (required on first run; persisted)
  --port <number>     Port to listen on (default ${DEFAULT_PORT}; persisted)
  --pair              Print pairing info (addresses, QR code, token) and exit
  --status            Print index status and exit
  -h, --help          Show this help
`;

function parseCli(argv: string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'music-dir': { type: 'string' },
        port: { type: 'string' },
        pair: { type: 'boolean' },
        status: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new ConfigError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  const options: CliOptions = {
    pair: values.pair ?? false,
    status: values.status ?? false,
    help: values.help ?? false,
  };
  if (values['music-dir'] !== undefined) options.musicDir = values['music-dir'];
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`Invalid --port value: ${values.port} (expected 1-65535)`);
    }
    options.port = port;
  }
  return options;
}

function readVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }

  const overrides: ConfigOverrides = {};
  if (cli.musicDir !== undefined) overrides.musicDir = cli.musicDir;
  if (cli.port !== undefined) overrides.port = cli.port;
  const { config, firstRun } = loadConfig(overrides);

  if (cli.pair) {
    printPairing(config);
    return;
  }

  const store = new IndexStore(indexFilePath);
  store.load();

  if (cli.status) {
    console.log(`data dir:  ${dataDir}`);
    console.log(`music dir: ${config.musicDir}`);
    console.log(`port:      ${config.port}`);
    console.log(`tracks:    ${store.trackCount}`);
    console.log(`rev:       ${store.rev}`);
    return;
  }

  let musicDirStat: fs.Stats;
  try {
    musicDirStat = fs.statSync(config.musicDir);
  } catch {
    throw new ConfigError(
      `Music folder not found: ${config.musicDir}\nPass --music-dir <path> to point at your library.`,
    );
  }
  if (!musicDirStat.isDirectory()) {
    throw new ConfigError(`Not a folder: ${config.musicDir}`);
  }

  store.installExitHandlers();
  const artwork = new ArtworkStore(artworkDir, store);

  console.log(`Indexing ${config.musicDir} ...`);
  const started = Date.now();
  const stats = await scanLibrary(config.musicDir, store, artwork);
  await store.flush();
  console.log(
    `Indexed ${stats.total} tracks in ${Date.now() - started} ms ` +
      `(${stats.indexed} scanned, ${stats.reused} unchanged, ${stats.removed} removed) — rev ${store.rev}`,
  );

  startWatcher(config.musicDir, { store, artwork });

  const deps: ServerDeps = {
    serverId: config.serverId,
    name: config.name,
    version: readVersion(),
    token: config.token,
    getRev: () => store.rev,
    getTracks: () =>
      store.entries().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    getTrackById: (id) => store.getById(id),
    getTrackFilePath: (entry) => path.join(config.musicDir, entry.path),
    getArtwork: (artworkId) => {
      const mime = store.getArtworkMime(artworkId);
      if (mime === undefined) return undefined;
      return { filePath: artwork.filePath(artworkId), mime };
    },
  };

  const app = await buildServer(deps);
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`Serving on port ${config.port} (serverId ${config.serverId})`);

  if (firstRun) {
    printPairing(config);
  } else {
    console.log('Run with --pair to show pairing info.');
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
