import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@music-sync/shared';
import { ArtworkStore } from './artwork.js';
import {
  addLibrary,
  artworkDir,
  configFilePath,
  ConfigError,
  dataDir,
  libraryIndexPath,
  loadConfig,
  removeLibrary,
  resolveLibrary,
  type ConfigOverrides,
  type LibraryConfig,
  type ServerConfig,
} from './config.js';
import { buildServer, digestToken, type LibraryRuntime, type ServerDeps } from './http.js';
import { scanLibrary } from './indexer.js';
import { printPairing } from './pairing.js';
import { IndexStore } from './store.js';
import { startWatcher } from './watcher.js';

interface CliOptions {
  musicDir?: string;
  port?: number;
  library?: string;
  addLibrary?: string;
  removeLibrary?: string;
  pair: boolean;
  status: boolean;
  help: boolean;
}

const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const USAGE = `music-sync server

Usage:
  npm start --workspace server -- [options]

Options:
  --music-dir <path>       Music folder to index (required on first run; persisted)
  --port <number>          Port to listen on (default ${DEFAULT_PORT}; persisted)
  --library <name>         Library targeted by --pair or --music-dir
  --pair                   Print pairing info and exit
  --status                 Print status for every library and exit
  --add-library <name>     Add a library (requires --music-dir), pair it, and exit
  --remove-library <name>  Remove a library from config and exit (files are kept)
  -h, --help               Show this help
`;

function parseCli(argv: string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'music-dir': { type: 'string' },
        port: { type: 'string' },
        library: { type: 'string' },
        pair: { type: 'boolean' },
        status: { type: 'boolean' },
        'add-library': { type: 'string' },
        'remove-library': { type: 'string' },
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
  if (values.library !== undefined) options.library = values.library;
  if (values['add-library'] !== undefined) options.addLibrary = values['add-library'];
  if (values['remove-library'] !== undefined) options.removeLibrary = values['remove-library'];
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`Invalid --port value: ${values.port} (expected 1-65535)`);
    }
    options.port = port;
  }
  return options;
}

function validateCli(cli: CliOptions): void {
  const commands = [cli.pair, cli.status, cli.addLibrary !== undefined, cli.removeLibrary !== undefined]
    .filter(Boolean).length;
  if (commands > 1) {
    throw new ConfigError('Choose only one of --pair, --status, --add-library, or --remove-library.');
  }
  if (cli.addLibrary !== undefined && cli.musicDir === undefined) {
    throw new ConfigError('--add-library requires --music-dir <path>.');
  }
  if (cli.addLibrary !== undefined && !LIBRARY_NAME_RE.test(cli.addLibrary)) {
    throw new ConfigError(
      `Invalid library name '${cli.addLibrary}' (use lowercase letters, digits, dashes).`,
    );
  }
  if (cli.addLibrary !== undefined && cli.library !== undefined) {
    throw new ConfigError('Do not combine --add-library with --library; the new name is the --add-library value.');
  }
  if (cli.library !== undefined && !LIBRARY_NAME_RE.test(cli.library)) {
    throw new ConfigError(
      `Invalid library name '${cli.library}' (use lowercase letters, digits, dashes).`,
    );
  }
  if (cli.removeLibrary !== undefined && (cli.musicDir !== undefined || cli.library !== undefined)) {
    throw new ConfigError('Do not combine --remove-library with --music-dir or --library.');
  }
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

function printStatus(config: ServerConfig): void {
  const rows = config.libraries.map((library) => {
    const store = new IndexStore(libraryIndexPath(library.name));
    store.load();
    return {
      name: library.name,
      dir: library.musicDir,
      tracks: store.trackCount,
      rev: store.rev,
    };
  });
  console.log(`data dir: ${dataDir}`);
  console.log(`port:     ${config.port}`);
  console.table(rows);
}

function availableLibraries(config: ServerConfig): LibraryConfig[] {
  const available: LibraryConfig[] = [];
  const problems: string[] = [];
  for (const library of config.libraries) {
    try {
      const stat = fs.statSync(library.musicDir);
      if (!stat.isDirectory()) {
        problems.push(`${library.name}: not a folder (${library.musicDir})`);
      } else {
        available.push(library);
      }
    } catch {
      problems.push(`${library.name}: folder not found (${library.musicDir})`);
    }
  }

  if (available.length === 0) {
    throw new ConfigError(
      `No configured music folders are available:\n${problems.map((problem) => `  ${problem}`).join('\n')}\n` +
        'Pass --library <name> --music-dir <path> to update a library.',
    );
  }
  for (const problem of problems) console.warn(`Skipping library ${problem}`);
  return available;
}

async function createRuntime(library: LibraryConfig): Promise<LibraryRuntime> {
  const store = new IndexStore(libraryIndexPath(library.name));
  store.load();
  store.installExitHandlers();
  const artwork = new ArtworkStore(artworkDir, store);

  console.log(`[${library.name}] Indexing ${library.musicDir} ...`);
  const started = Date.now();
  const stats = await scanLibrary(library.musicDir, store, artwork);
  await store.flush();
  console.log(
    `[${library.name}] Indexed ${stats.total} tracks in ${Date.now() - started} ms ` +
      `(${stats.indexed} scanned, ${stats.reused} unchanged, ${stats.removed} removed) — rev ${store.rev}`,
  );

  startWatcher(library.musicDir, { store, artwork });

  return {
    name: library.name,
    serverId: library.serverId,
    tokenDigest: digestToken(library.token),
    getRev: () => store.rev,
    getTracks: () =>
      store.entries().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    getTrackById: (id) => store.getById(id),
    getTrackFilePath: (entry) => path.join(library.musicDir, entry.path),
    getArtwork: (artworkId) => {
      const mime = store.getArtworkMime(artworkId);
      if (mime === undefined) return undefined;
      return { filePath: artwork.filePath(artworkId), mime };
    },
  };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  validateCli(cli);

  const addingFirstLibrary = cli.addLibrary !== undefined && !fs.existsSync(configFilePath);
  const overrides: ConfigOverrides = {};
  if (cli.port !== undefined) overrides.port = cli.port;
  if (addingFirstLibrary) {
    overrides.musicDir = cli.musicDir;
    overrides.library = cli.addLibrary;
  } else if (cli.addLibrary === undefined && cli.removeLibrary === undefined) {
    if (cli.musicDir !== undefined) overrides.musicDir = cli.musicDir;
    if (cli.library !== undefined) overrides.library = cli.library;
  }

  let { config, firstRun } = loadConfig(overrides);

  if (cli.addLibrary !== undefined) {
    let library: LibraryConfig;
    if (addingFirstLibrary) {
      library = resolveLibrary(config, cli.addLibrary);
    } else {
      ({ config, library } = addLibrary(config, cli.addLibrary, cli.musicDir!));
    }
    printPairing(config, library);
    return;
  }

  if (cli.removeLibrary !== undefined) {
    config = removeLibrary(config, cli.removeLibrary);
    console.log(`Removed library '${cli.removeLibrary}'. Music and index files were left untouched.`);
    return;
  }

  if (cli.pair) {
    printPairing(config, resolveLibrary(config, cli.library));
    return;
  }

  if (cli.status) {
    printStatus(config);
    return;
  }

  const runtimes: LibraryRuntime[] = [];
  for (const library of availableLibraries(config)) runtimes.push(await createRuntime(library));

  const deps: ServerDeps = {
    name: config.name,
    version: readVersion(),
    libraries: runtimes,
  };
  const app = await buildServer(deps);
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`Serving ${runtimes.length} ${runtimes.length === 1 ? 'library' : 'libraries'} on port ${config.port}`);

  if (firstRun) {
    printPairing(config, config.libraries[0]!);
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
