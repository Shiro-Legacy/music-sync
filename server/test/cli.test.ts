import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Fixture {
  root: string;
  dataDir: string;
  aliceDir: string;
  bobDir: string;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = path.join(repoRoot, 'server');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixtures: Fixture[] = [];

async function makeFixture(): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msync-cli-'));
  const fixture = {
    root,
    dataDir: path.join(root, 'data'),
    aliceDir: path.join(root, 'alice'),
    bobDir: path.join(root, 'bob'),
  };
  await Promise.all([
    fsp.mkdir(fixture.dataDir, { recursive: true }),
    fsp.mkdir(fixture.aliceDir, { recursive: true }),
    fsp.mkdir(fixture.bobDir, { recursive: true }),
  ]);
  fixtures.push(fixture);
  return fixture;
}

function runCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'src/index.ts', ...args], {
      cwd: serverRoot,
      env: { ...process.env, MUSIC_SYNC_DATA_DIR: fixture.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: 1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

async function readConfig(fixture: Fixture): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(fixture.dataDir, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  await fsp.access(tsxCli);
});

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fsp.rm(fixture.root, { recursive: true, force: true })));
});

describe('CLI multi-library commands', () => {
  it('adds libraries, pairs a selected library, and removes it', async () => {
    const fixture = await makeFixture();

    const first = await runCli(fixture, [
      '--add-library',
      'alice',
      '--music-dir',
      fixture.aliceDir,
    ]);
    expect(first.status).toBe(0);
    expect(`${first.stdout}${first.stderr}`).toContain('Library: alice');
    const firstConfig = await readConfig(fixture);
    expect(firstConfig.v).toBe(2);
    expect(firstConfig.libraries).toHaveLength(1);

    const second = await runCli(fixture, [
      '--add-library',
      'bob',
      '--music-dir',
      fixture.bobDir,
    ]);
    expect(second.status).toBe(0);
    expect(`${second.stdout}${second.stderr}`).toContain('Library: bob');
    expect((await readConfig(fixture)).libraries).toHaveLength(2);

    const pair = await runCli(fixture, ['--pair', '--library', 'bob']);
    expect(pair.status).toBe(0);
    expect(`${pair.stdout}${pair.stderr}`).toContain('Library: bob');

    const remove = await runCli(fixture, ['--remove-library', 'bob']);
    expect(remove.status).toBe(0);
    expect(remove.stdout).toContain("Removed library 'bob'");
    const finalConfig = await readConfig(fixture);
    expect((finalConfig.libraries as Array<{ name: string }>).map(({ name }) => name)).toEqual([
      'alice',
    ]);
  });

  it('requires an explicit library for pair when multiple libraries exist', async () => {
    const fixture = await makeFixture();
    expect((await runCli(fixture, ['--add-library', 'alice', '--music-dir', fixture.aliceDir])).status).toBe(0);
    expect((await runCli(fixture, ['--add-library', 'bob', '--music-dir', fixture.bobDir])).status).toBe(0);

    const pair = await runCli(fixture, ['--pair']);
    expect(pair.status).toBe(1);
    expect(`${pair.stdout}${pair.stderr}`).toContain(
      'This server has 2 libraries — pass --library <name>.',
    );
  });

  it('guards against removing the last library', async () => {
    const fixture = await makeFixture();
    expect((await runCli(fixture, ['--add-library', 'alice', '--music-dir', fixture.aliceDir])).status).toBe(0);

    const remove = await runCli(fixture, ['--remove-library', 'alice']);
    expect(remove.status).toBe(1);
    expect(`${remove.stdout}${remove.stderr}`).toContain('Cannot remove the last library');
    expect((await readConfig(fixture)).libraries).toHaveLength(1);
  });
});
