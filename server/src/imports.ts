import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ImportJobSchema,
  type ImportJob,
  type ImportPreview,
} from '@music-sync/shared';
import type { ArtworkStore } from './artwork.js';
import { indexFile, trackId } from './indexer.js';
import type { IndexStore } from './store.js';
import { canonicalizeYouTubeUrl, YoutubeUrlError } from './youtube-url.js';

export { canonicalizeYouTubeUrl, YoutubeUrlError };

const MAX_DURATION_SEC = 30 * 60;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 10;
const PREVIEW_LIMIT = 2;
const TERMINAL_HISTORY = 100;
const MIN_YTDLP_VERSION = '2026.08.19';
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio';
const LIVE_REJECT = new Set(['is_live', 'is_upcoming', 'post_live']);

const PersistedJobsSchema = z.object({
  v: z.literal(1),
  jobs: z.array(ImportJobSchema),
});

export class ImportError extends Error {
  constructor(
    readonly status: 400 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface ImportService {
  preview(url: string): Promise<ImportPreview>;
  submit(input: { url: string; title: string; artist: string }): Promise<{
    job: ImportJob;
    existingReady: boolean;
  }>;
  list(): Promise<{ available: boolean; unavailableReason?: string; jobs: ImportJob[] }>;
}

export interface ImportTools {
  ytdlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegDir: string;
}

export interface ImportHooks {
  tools?: () => Promise<{ ok: true; tools: ImportTools } | { ok: false; reason: string }>;
  previewMeta?: (url: string) => Promise<unknown>;
  download?: (opts: { url: string; stagingDir: string; videoId: string }) => Promise<string>;
  tag?: (inputPath: string, outputPath: string, title: string, artist: string) => Promise<void>;
  probe?: (filePath: string, expectedDurationSec: number) => Promise<void>;
}

type ToolsResult = { ok: true; tools: ImportTools } | { ok: false; reason: string };

export class ImportQueue {
  private readonly waiting: Array<() => Promise<void>> = [];
  private reserved = 0;
  private running = false;
  private previewCount = 0;

  tryPreview(): boolean {
    if (this.previewCount >= PREVIEW_LIMIT) return false;
    this.previewCount += 1;
    return true;
  }

  endPreview(): void {
    this.previewCount = Math.max(0, this.previewCount - 1);
  }

  tryReserve(): boolean {
    if (this.waiting.length + this.reserved >= QUEUE_LIMIT) return false;
    this.reserved += 1;
    return true;
  }

  cancelReserve(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  commit(task: () => Promise<void>): void {
    this.reserved = Math.max(0, this.reserved - 1);
    this.waiting.push(task);
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    const task = this.waiting.shift();
    if (task === undefined) return;
    this.running = true;
    void task()
      .then(undefined, (err: unknown) => {
        console.warn(`import queue: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }
}

const trackedPids = new Set<number>();
let exitGuardInstalled = false;

function installExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  process.on('exit', () => {
    killTrackedChildren();
  });
}

installExitGuard();

export function killTrackedChildren(): void {
  for (const pid of [...trackedPids]) {
    killPidTree(pid);
    trackedPids.delete(pid);
  }
}

function killPidTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // already gone
  }
}

function spawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '' };
  if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  if (process.env['LANG'] !== undefined) env['LANG'] = process.env['LANG'];
  if (process.platform === 'win32') {
    if (process.env['SYSTEMROOT'] !== undefined) env['SYSTEMROOT'] = process.env['SYSTEMROOT'];
    if (process.env['WINDIR'] !== undefined) env['WINDIR'] = process.env['WINDIR'];
    if (process.env['TEMP'] !== undefined) env['TEMP'] = process.env['TEMP'];
  }
  return env;
}

function dirSizeSync(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeSync(abs);
      else if (entry.isFile()) total += fs.statSync(abs).size;
    } catch {
      // skip
    }
  }
  return total;
}

export function runDetached(
  command: string,
  args: string[],
  opts: {
    timeoutMs: number;
    cwd?: string;
    onChunk?: (chunk: string) => void;
    watchDir?: string;
    maxDirBytes?: number;
  },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: opts.cwd,
        env: spawnEnv(),
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    } catch (err) {
      reject(err);
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) trackedPids.add(pid);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let tooLarge = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (pid !== undefined) trackedPids.delete(pid);
      fn();
    };

    const killChild = (): void => {
      if (pid !== undefined) killPidTree(pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, opts.timeoutMs);

    const watch =
      opts.watchDir !== undefined && opts.maxDirBytes !== undefined
        ? setInterval(() => {
            if (dirSizeSync(opts.watchDir!) > opts.maxDirBytes!) {
              tooLarge = true;
              killChild();
            }
          }, 250)
        : undefined;

    const take = (text: string, dest: 'out' | 'err'): void => {
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > MAX_OUTPUT) {
        overflow = true;
        killChild();
        return;
      }
      if (dest === 'out') stdout += text;
      else stderr += text;
      opts.onChunk?.(text);
    };

    child.stdout?.on('data', (chunk: string) => take(chunk, 'out'));
    child.stderr?.on('data', (chunk: string) => take(chunk, 'err'));
    child.once('error', (err) => {
      killChild();
      settle(() => reject(err));
    });
    child.once('close', (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`));
        }
        else if (tooLarge) reject(new ImportError(400, 'Audio is larger than 100 MiB'));
        else if (overflow) reject(new Error('subprocess output too large'));
        else resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  });
}

function findOnPath(cmd: string): string | undefined {
  const extra = process.platform === 'win32' ? '.exe' : '';
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, `${cmd}${extra}`);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function parseYtdlpVersion(text: string): string | undefined {
  return /(\d{4}\.\d{2}\.\d{2})/.exec(text)?.[1];
}

const NEGATIVE_TTL_MS = 30_000;
let cachedTools: { result: ToolsResult; at: number } | undefined;
let inFlightProbe: Promise<ToolsResult> | undefined;

async function probeTools(): Promise<ToolsResult> {
  if (cachedTools?.result.ok) return cachedTools.result;
  if (
    cachedTools !== undefined &&
    !cachedTools.result.ok &&
    Date.now() - cachedTools.at < NEGATIVE_TTL_MS
  ) {
    return cachedTools.result;
  }
  if (inFlightProbe !== undefined) return inFlightProbe;
  inFlightProbe = probeToolsUncached()
    .then((result) => {
      cachedTools = { result, at: Date.now() };
      return result;
    })
    .finally(() => {
      inFlightProbe = undefined;
    });
  return inFlightProbe;
}

async function probeToolsUncached(): Promise<ToolsResult> {
  const ytdlpPath = process.env['MUSIC_SYNC_YTDLP_PATH'] ?? findOnPath('yt-dlp');
  const ffmpegPath = findOnPath('ffmpeg');
  const ffprobePath = findOnPath('ffprobe');
  const missing: string[] = [];
  if (ytdlpPath === undefined) missing.push('yt-dlp');
  if (ffmpegPath === undefined) missing.push('ffmpeg');
  if (ffprobePath === undefined) missing.push('ffprobe');
  if (missing.length > 0) {
    return { ok: false, reason: `YouTube imports need ${missing.join(', ')}` };
  }
  try {
    const versioned = await runDetached(ytdlpPath!, ['--ignore-config', '--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versioned.code !== 0) {
      return { ok: false, reason: 'Could not read yt-dlp version' };
    }
    const version = parseYtdlpVersion(versioned.stdout) ?? parseYtdlpVersion(versioned.stderr);
    if (version === undefined) {
      return { ok: false, reason: 'Could not read yt-dlp version' };
    }
    if (version < MIN_YTDLP_VERSION) {
      return {
        ok: false,
        reason: `yt-dlp ${version} too old, need >= ${MIN_YTDLP_VERSION}`,
      };
    }
    const ffmpeg = await runDetached(ffmpegPath!, ['-version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (ffmpeg.code !== 0) return { ok: false, reason: 'ffmpeg is not usable' };
    const ffprobe = await runDetached(ffprobePath!, ['-version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (ffprobe.code !== 0) return { ok: false, reason: 'ffprobe is not usable' };
    return {
      ok: true,
      tools: {
        ytdlpPath: ytdlpPath!,
        ffmpegPath: ffmpegPath!,
        ffprobePath: ffprobePath!,
        ffmpegDir: path.dirname(ffmpegPath!),
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, reason: 'YouTube imports need yt-dlp, ffmpeg, and ffprobe' };
    }
    return {
      ok: false,
      reason: `YouTube import tools are unavailable (${sanitizeError(err)})`,
    };
  }
}

export function ytdlpCommonArgs(tools: ImportTools): string[] {
  return [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-remote-components',
    '--no-playlist',
    '--no-cookies',
    '--no-warnings',
    '--newline',
    '--use-extractors',
    'youtube$',
    '--js-runtimes',
    `node:${process.execPath}`,
    '--ffmpeg-location',
    tools.ffmpegDir,
  ];
}

export function importRelPath(videoId: string): string {
  return `YouTube/${videoId}.m4a`;
}

export function importAbsPath(musicDir: string, videoId: string): string {
  return path.join(musicDir, 'YouTube', `${videoId}.m4a`);
}

export function stagingRoot(musicDir: string): string {
  return path.join(musicDir, '.music-sync-imports');
}

const YtdlpMetaSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  track: z.string().optional(),
  artist: z.string().optional(),
  creator: z.string().optional(),
  uploader: z.string().optional(),
  channel: z.string().optional(),
  duration: z.number().finite().optional(),
  is_live: z.boolean().optional(),
  live_status: z.string().nullable().optional(),
  thumbnail: z.string().optional(),
  filesize: z.number().finite().optional(),
  filesize_approx: z.number().finite().optional(),
});

export function assertImportable(meta: unknown): {
  durationSec: number;
  title: string;
  artist: string;
  thumbnailUrl?: string;
  videoId?: string;
} {
  const parsed = YtdlpMetaSchema.safeParse(meta);
  if (!parsed.success) {
    throw new ImportError(400, 'Could not read video metadata');
  }
  const info = parsed.data;
  if (info.duration === undefined || info.duration <= 0) {
    throw new ImportError(400, 'Video duration is unknown');
  }
  if (info.duration > MAX_DURATION_SEC) {
    throw new ImportError(400, 'Videos longer than 30 minutes cannot be imported');
  }
  if (info.is_live === true || LIVE_REJECT.has(info.live_status ?? '')) {
    throw new ImportError(400, 'Live and upcoming videos cannot be imported');
  }
  const size = info.filesize ?? info.filesize_approx;
  if (size !== undefined && size > MAX_BYTES) {
    throw new ImportError(400, 'Audio is larger than 100 MiB');
  }
  const title = (info.track ?? info.title ?? 'YouTube video').trim() || 'YouTube video';
  const artist =
    (info.artist ?? info.creator ?? info.uploader ?? info.channel ?? 'Unknown Artist').trim() ||
    'Unknown Artist';
  let thumbnailUrl: string | undefined;
  if (info.thumbnail !== undefined) {
    try {
      const thumb = new URL(info.thumbnail);
      if (thumb.protocol === 'https:') thumbnailUrl = info.thumbnail;
    } catch {
      // omit
    }
  }
  return {
    durationSec: info.duration,
    title: title.slice(0, 300),
    artist: artist.slice(0, 300),
    ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
    ...(info.id !== undefined ? { videoId: info.id } : {}),
  };
}

function parseJsonObject(stdout: string): unknown {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new ImportError(400, 'Could not read video metadata');
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as unknown;
  } catch {
    throw new ImportError(400, 'Could not read video metadata');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line =
    text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .at(-1) ?? 'import failed';
  return line.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s:]+/g, '<path>').slice(0, 200);
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(abs);
    else if (entry.isFile()) {
      try {
        total += (await fsp.stat(abs)).size;
      } catch {
        // skip
      }
    }
  }
  return total;
}

async function findDownloadedAudio(stagingDir: string, videoId: string): Promise<string> {
  const preferred = path.join(stagingDir, `${videoId}.m4a`);
  try {
    const stat = await fsp.stat(preferred);
    if (stat.isFile()) return preferred;
  } catch {
    // missing
  }
  throw new ImportError(400, 'Download did not produce an M4A file');
}

export async function publishExclusive(stagingFile: string, destFile: string): Promise<'linked' | 'exists'> {
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  try {
    await fsp.link(stagingFile, destFile);
    await fsp.unlink(stagingFile).catch(() => undefined);
    return 'linked';
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return 'exists';
    throw err;
  }
}

async function defaultProbe(
  ffprobePath: string,
  filePath: string,
  expectedDurationSec: number,
  timeoutMs = 30_000,
): Promise<void> {
  const result = await runDetached(
    ffprobePath,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { timeoutMs },
  );
  if (result.code !== 0) throw new ImportError(400, 'Imported file is not valid AAC/M4A audio');
  let parsed: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      disposition?: { attached_pic?: number };
    }>;
    format?: { format_name?: string; duration?: string; size?: string };
  };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new ImportError(400, 'Imported file is not valid AAC/M4A audio');
  }
  const streams = parsed.streams ?? [];
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (audio.length !== 1 || audio[0]?.codec_name !== 'aac') {
    throw new ImportError(400, 'Imported file is not valid AAC/M4A audio');
  }
  for (const stream of streams) {
    if (stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1) {
      throw new ImportError(400, 'Imported file is not valid AAC/M4A audio');
    }
  }
  const formatName = parsed.format?.format_name ?? '';
  if (!formatName.includes('mp4')) {
    throw new ImportError(400, 'Imported file is not valid AAC/M4A audio');
  }
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDurationSec) > 5) {
    throw new ImportError(400, 'Imported audio duration does not match the video');
  }
  const size = Number(parsed.format?.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    throw new ImportError(400, 'Audio is larger than 100 MiB');
  }
}

async function defaultTag(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  title: string,
  artist: string,
  timeoutMs = 60_000,
  watchDir?: string,
): Promise<void> {
  const result = await runDetached(
    ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-y',
      '-i',
      inputPath,
      '-map',
      '0',
      '-c',
      'copy',
      '-metadata',
      `title=${title}`,
      '-metadata',
      `artist=${artist}`,
      outputPath,
    ],
    {
      timeoutMs,
      ...(watchDir !== undefined ? { watchDir, maxDirBytes: MAX_BYTES } : {}),
    },
  );
  if (result.code !== 0) {
    throw new ImportError(400, sanitizeError(result.stderr || 'ffmpeg failed to tag audio'));
  }
}

export interface LibraryImportsOptions {
  name: string;
  musicDir: string;
  jobsPath: string;
  store: IndexStore;
  artwork: ArtworkStore;
  queue: ImportQueue;
  onIndexed?: () => void;
  hooks?: ImportHooks;
}

export class LibraryImports implements ImportService {
  private readonly jobs: ImportJob[] = [];
  private corrupt = false;
  private writeChain: Promise<void> = Promise.resolve();
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly name: string;
  private readonly musicDir: string;
  private readonly jobsPath: string;
  private readonly store: IndexStore;
  private readonly artwork: ArtworkStore;
  private readonly queue: ImportQueue;
  private readonly onIndexed?: () => void;
  private readonly hooks: ImportHooks;

  constructor(options: LibraryImportsOptions) {
    this.name = options.name;
    this.musicDir = options.musicDir;
    this.jobsPath = options.jobsPath;
    this.store = options.store;
    this.artwork = options.artwork;
    this.queue = options.queue;
    this.onIndexed = options.onIndexed;
    this.hooks = options.hooks ?? {};
    this.load();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private load(): void {
    if (!fs.existsSync(this.jobsPath)) return;
    try {
      const parsed = PersistedJobsSchema.parse(
        JSON.parse(fs.readFileSync(this.jobsPath, 'utf8')),
      );
      this.jobs.push(...parsed.jobs);
    } catch {
      this.corrupt = true;
    }
  }

  private save(): Promise<void> {
    const done = this.writeChain.then(() => this.writeNow());
    this.writeChain = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private async writeNow(): Promise<void> {
    if (this.corrupt) return;
    const active = this.jobs.filter((job) => !isTerminal(job.state));
    const terminal = this.jobs
      .filter((job) => isTerminal(job.state))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, TERMINAL_HISTORY);
    const jobs = [...active, ...terminal];
    this.jobs.splice(0, this.jobs.length, ...jobs);
    const tmpPath = `${this.jobsPath}.tmp`;
    await fsp.mkdir(path.dirname(this.jobsPath), { recursive: true });
    await fsp.writeFile(
      tmpPath,
      `${JSON.stringify({ v: 1, jobs: this.jobs }, null, 2)}\n`,
      'utf8',
    );
    await fsp.rename(tmpPath, this.jobsPath);
  }

  private snapshot(job: ImportJob): ImportJob {
    return { ...job };
  }

  private listedJobs(): ImportJob[] {
    return [...this.jobs]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((job) => this.snapshot(job));
  }

  private async tools(): Promise<ToolsResult> {
    if (this.hooks.tools !== undefined) return this.hooks.tools();
    return probeTools();
  }

  async reconcile(): Promise<void> {
    try {
      await fsp.rm(stagingRoot(this.musicDir), { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[${this.name}] could not clear import staging: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (this.corrupt) return;
    let changed = false;
    const stamp = nowIso();
    for (const job of this.jobs) {
      if (!isTerminal(job.state)) {
        job.state = 'failed';
        job.error = 'Interrupted by server restart; retry';
        job.updatedAt = stamp;
        delete job.progress;
        changed = true;
      }
      const rel = importRelPath(job.videoId);
      const entry = this.store.get(rel);
      if (job.state !== 'ready' && entry !== undefined) {
        job.state = 'ready';
        job.trackId = entry.id;
        delete job.error;
        job.updatedAt = stamp;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async list(): Promise<{ available: boolean; unavailableReason?: string; jobs: ImportJob[] }> {
    const jobs = this.listedJobs();
    if (this.corrupt) {
      return {
        available: false,
        unavailableReason: `imports-${this.name}.json is corrupt; move it aside`,
        jobs,
      };
    }
    const tools = await this.tools();
    if (!tools.ok) {
      return { available: false, unavailableReason: tools.reason, jobs };
    }
    return { available: true, jobs };
  }

  async preview(url: string): Promise<ImportPreview> {
    if (this.corrupt) {
      throw new ImportError(503, `imports-${this.name}.json is corrupt; move it aside`);
    }
    const canonical = canonicalizeYouTubeUrl(url);
    if (!this.queue.tryPreview()) throw new ImportError(429, 'preview busy');
    try {
      const tools = await this.tools();
      if (!tools.ok) throw new ImportError(503, tools.reason);
      const meta =
        this.hooks.previewMeta !== undefined
          ? await this.hooks.previewMeta(canonical.url)
          : await this.dumpMeta(tools.tools, canonical.url);
      const checked = assertImportable(meta);
      if (checked.videoId !== undefined && checked.videoId !== canonical.videoId) {
        throw new ImportError(400, 'Not a YouTube video URL');
      }
      const preview: ImportPreview = {
        videoId: canonical.videoId,
        url: canonical.url,
        title: checked.title,
        artist: checked.artist,
        durationSec: checked.durationSec,
        ...(checked.thumbnailUrl !== undefined ? { thumbnailUrl: checked.thumbnailUrl } : {}),
      };
      return preview;
    } finally {
      this.queue.endPreview();
    }
  }

  async submit(input: { url: string; title: string; artist: string }): Promise<{
    job: ImportJob;
    existingReady: boolean;
  }> {
    return this.exclusive(() => this.submitLocked(input));
  }

  private async submitLocked(input: { url: string; title: string; artist: string }): Promise<{
    job: ImportJob;
    existingReady: boolean;
  }> {
    if (this.corrupt) {
      throw new ImportError(503, `imports-${this.name}.json is corrupt; move it aside`);
    }
    const canonical = canonicalizeYouTubeUrl(input.url);
    const tools = await this.tools();
    if (!tools.ok) throw new ImportError(503, tools.reason);

    const rel = importRelPath(canonical.videoId);
    const existingFile = this.store.get(rel);
    const inFlight = [...this.jobs]
      .reverse()
      .find((job) => job.videoId === canonical.videoId && !isTerminal(job.state));
    if (inFlight !== undefined) return { job: this.snapshot(inFlight), existingReady: false };

    const existingReady = [...this.jobs]
      .reverse()
      .find((job) => job.videoId === canonical.videoId && job.state === 'ready');
    if (existingFile !== undefined) {
      if (existingReady !== undefined) {
        existingReady.trackId = existingFile.id;
        return { job: this.snapshot(existingReady), existingReady: true };
      }
      const ready = this.newJob(canonical, input.title, input.artist);
      ready.state = 'ready';
      ready.trackId = existingFile.id;
      this.jobs.push(ready);
      await this.save();
      return { job: this.snapshot(ready), existingReady: true };
    }

    if (!this.queue.tryReserve()) throw new ImportError(429, 'import queue full');
    const job = this.newJob(canonical, input.title, input.artist);
    this.jobs.push(job);
    try {
      await this.save();
    } catch {
      this.jobs.pop();
      this.queue.cancelReserve();
      throw new ImportError(503, 'Could not persist import job');
    }
    this.queue.commit(() => this.process(job.id));
    return { job: this.snapshot(job), existingReady: false };
  }

  private newJob(
    canonical: { videoId: string; url: string },
    title: string,
    artist: string,
  ): ImportJob {
    const stamp = nowIso();
    return {
      id: randomUUID(),
      videoId: canonical.videoId,
      url: canonical.url,
      title,
      artist,
      state: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
    };
  }

  private async process(jobId: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) return;
    const stagingDir = path.join(stagingRoot(this.musicDir), job.id);
    try {
      await this.runJob(job, stagingDir);
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof ImportError ? err.message : sanitizeError(err);
      job.updatedAt = nowIso();
      delete job.progress;
      await this.save().catch((err: unknown) => {
        console.warn(
          `[${this.name}] import ${job.id}: could not persist failure: ${sanitizeError(err)}`,
        );
      });
    } finally {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runJob(job: ImportJob, stagingDir: string): Promise<void> {
    const rel = importRelPath(job.videoId);
    const dest = importAbsPath(this.musicDir, job.videoId);
    const existing = this.store.get(rel);
    if (existing !== undefined) {
      job.state = 'ready';
      job.trackId = existing.id;
      delete job.error;
      job.updatedAt = nowIso();
      await this.save();
      return;
    }

    job.state = 'downloading';
    job.updatedAt = nowIso();
    await this.save();

    await fsp.mkdir(stagingDir, { recursive: true });
    const tools = await this.tools();
    if (!tools.ok) throw new ImportError(503, tools.reason);

    const deadline = Date.now() + IMPORT_TIMEOUT_MS;
    const remaining = (): number => Math.max(1000, deadline - Date.now());

    const meta = await this.dumpMeta(
      tools.tools,
      job.url,
      Math.min(PREVIEW_TIMEOUT_MS, remaining()),
    );
    const checked = assertImportable(meta);
    if (checked.videoId !== undefined && checked.videoId !== job.videoId) {
      throw new ImportError(400, 'Not a YouTube video URL');
    }

    const taggedPath = path.join(stagingDir, 'tagged.m4a');
    let audioPath: string;
    if (this.hooks.download !== undefined) {
      audioPath = await this.hooks.download({
        url: job.url,
        stagingDir,
        videoId: job.videoId,
      });
    } else {
      await this.downloadAudio(tools.tools, job, stagingDir, remaining());
      if ((await dirSize(stagingDir)) > MAX_BYTES) {
        throw new ImportError(400, 'Audio is larger than 100 MiB');
      }
      const downloaded = await findDownloadedAudio(stagingDir, job.videoId);
      job.state = 'processing';
      job.updatedAt = nowIso();
      await this.save();
      if (this.hooks.tag !== undefined) {
        await this.hooks.tag(downloaded, taggedPath, job.title, job.artist);
      } else {
        await defaultTag(
          tools.tools.ffmpegPath,
          downloaded,
          taggedPath,
          job.title,
          job.artist,
          remaining(),
          stagingDir,
        );
      }
      audioPath = taggedPath;
    }

    job.state = 'processing';
    job.updatedAt = nowIso();
    await this.save();
    if (this.hooks.probe !== undefined) {
      await this.hooks.probe(audioPath, checked.durationSec);
    } else if (this.hooks.download === undefined) {
      await defaultProbe(tools.tools.ffprobePath, audioPath, checked.durationSec, remaining());
    }

    const stat = await fsp.stat(audioPath);
    if (stat.size > MAX_BYTES) throw new ImportError(400, 'Audio is larger than 100 MiB');
    if ((await dirSize(stagingDir)) > MAX_BYTES) {
      throw new ImportError(400, 'Audio is larger than 100 MiB');
    }

    job.state = 'indexing';
    job.updatedAt = nowIso();
    await this.save();

    const published = await publishExclusive(audioPath, dest);
    if (published === 'exists') {
      // Keep the already-published file.
    }
    const outcome = await indexFile(this.musicDir, dest, this.store, this.artwork);
    if (outcome === 'indexed') {
      this.store.bumpRev();
      this.store.schedulePersist();
      this.onIndexed?.();
    } else if (this.store.get(rel) === undefined) {
      throw new ImportError(400, 'Imported file could not be indexed');
    }
    const entry = this.store.get(rel);
    if (entry === undefined) throw new ImportError(400, 'Imported file could not be indexed');
    // Staging is gone before the job is ever observable as ready (process() re-runs rm as a no-op).
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    job.state = 'ready';
    job.trackId = entry.id;
    delete job.error;
    delete job.progress;
    job.updatedAt = nowIso();
    await this.save();
  }

  private async dumpMeta(
    tools: ImportTools,
    url: string,
    timeoutMs = PREVIEW_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.hooks.previewMeta !== undefined) return this.hooks.previewMeta(url);
    const result = await runDetached(
      tools.ytdlpPath,
      [...ytdlpCommonArgs(tools), '-f', AUDIO_FORMAT, '--skip-download', '-J', url],
      { timeoutMs },
    );
    if (result.code !== 0) {
      throw new ImportError(400, sanitizeError(result.stderr || result.stdout || 'yt-dlp failed'));
    }
    return parseJsonObject(result.stdout);
  }

  private async downloadAudio(
    tools: ImportTools,
    job: ImportJob,
    stagingDir: string,
    timeoutMs: number,
  ): Promise<void> {
    let leftover = '';
    const takeProgress = (chunk: string): void => {
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^\s*([\d.]+)%/.exec(line);
        if (match === null) continue;
        const percent = Number(match[1]);
        if (Number.isFinite(percent) && percent >= 0 && percent <= 100) job.progress = percent;
      }
    };
    const result = await runDetached(
      tools.ytdlpPath,
      [
        ...ytdlpCommonArgs(tools),
        '--max-filesize',
        '100M',
        '-f',
        AUDIO_FORMAT,
        '-x',
        '--audio-format',
        'm4a',
        '--embed-thumbnail',
        '--progress',
        '--progress-template',
        'download:%(progress._percent_str)s',
        '-P',
        stagingDir,
        '-o',
        '%(id)s.%(ext)s',
        job.url,
      ],
      {
        timeoutMs,
        watchDir: stagingDir,
        maxDirBytes: MAX_BYTES,
        onChunk: takeProgress,
      },
    );
    if (result.code !== 0) {
      throw new ImportError(400, sanitizeError(result.stderr || result.stdout || 'yt-dlp failed'));
    }
  }
}

function isTerminal(state: ImportJob['state']): boolean {
  return state === 'ready' || state === 'failed';
}
