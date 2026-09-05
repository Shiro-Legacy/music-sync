import { execFile } from 'node:child_process';
import path from 'node:path';
import type { TrackEntry } from '@music-sync/shared';
import type { IndexStore } from './store.js';

/** EBU R128 integrated loudness (LUFS) and true peak (dBTP) of one file. */
export interface LoudnessMeasurement {
  loudness: number;
  truePeak: number;
}

/** Injectable measurer (tests substitute a fake; production runs ffmpeg). */
export type LoudnessMeasurer = (filePath: string) => Promise<LoudnessMeasurement | undefined>;

const FFMPEG_MAX_OUTPUT = 8 * 1024 * 1024;

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      { maxBuffer: FFMPEG_MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') reject(err);
          // Non-zero exit (unreadable/corrupt file): let the parser decide from stderr.
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** True when `ffmpeg -version` runs. */
export async function ffmpegAvailable(ffmpegPath = 'ffmpeg'): Promise<boolean> {
  try {
    await runFfmpeg(ffmpegPath, ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the summary block the `ebur128` filter prints at the end of a run:
 *
 *   Integrated loudness:
 *     I:          -8.3 LUFS
 *     ...
 *   True peak:
 *     Peak:        2.6 dBFS
 *
 * Returns undefined when either value is missing or non-finite (silent file → `-inf`).
 */
export function parseEbur128(output: string): LoudnessMeasurement | undefined {
  const integrated = [...output.matchAll(/^\s*I:\s*(-?[\d.]+|-?inf|nan)\s*LUFS\s*$/gm)].at(-1);
  const peak = [...output.matchAll(/^\s*Peak:\s*(-?[\d.]+|-?inf|nan)\s*dBFS\s*$/gm)].at(-1);
  if (integrated === undefined || peak === undefined) return undefined;
  const loudness = Number(integrated[1]);
  const truePeak = Number(peak[1]);
  if (!Number.isFinite(loudness) || !Number.isFinite(truePeak)) return undefined;
  return { loudness, truePeak };
}

/**
 * Measures one file with ffmpeg's `ebur128` filter (integrated loudness + true peak),
 * decoding to the null muxer. Throws only when ffmpeg itself cannot be started (ENOENT);
 * an unreadable file resolves to undefined.
 */
export async function measureLoudness(
  filePath: string,
  ffmpegPath = 'ffmpeg',
): Promise<LoudnessMeasurement | undefined> {
  const { stderr } = await runFfmpeg(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vn',
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  return parseEbur128(stderr);
}

export function needsLoudness(entry: TrackEntry): boolean {
  return entry.format !== 'unsupported' && entry.loudness === undefined;
}

export interface LoudnessScannerOptions {
  measure?: LoudnessMeasurer;
  /** Parallel ffmpeg processes (default 2 — measuring is CPU-bound, and the server keeps serving). */
  concurrency?: number;
  /** How often a long pass publishes partial results by bumping rev (default 60 s). */
  publishIntervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Background loudness pass over an index. Runs after every scan/watcher change,
 * measures entries that have no `loudness`, writes the values back into the store,
 * and bumps rev so paired phones pick them up on their next manifest fetch.
 *
 * Measuring is slow (a few seconds per track) so it never blocks indexing or serving:
 * tracks without a value simply play at the reference level until measured.
 * A file that changes while being measured (content key differs on write-back) is
 * re-queued by the next pass. Files ffmpeg cannot read are skipped for the process
 * lifetime and retried on the next server start.
 */
export class LoudnessScanner {
  private readonly measure: LoudnessMeasurer;
  private readonly concurrency: number;
  private readonly publishIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly failed = new Set<string>();
  private running: Promise<void> | undefined;
  private rerun = false;

  constructor(
    private readonly musicDir: string,
    private readonly store: IndexStore,
    options: LoudnessScannerOptions = {},
  ) {
    this.measure = options.measure ?? ((filePath) => measureLoudness(filePath));
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.publishIntervalMs = options.publishIntervalMs ?? 60_000;
    this.log = options.log ?? ((message: string) => console.log(message));
  }

  /** Number of entries still waiting for a measurement (excluding files that failed). */
  pendingCount(): number {
    return this.store.entries().filter((e) => needsLoudness(e) && !this.failed.has(e.path)).length;
  }

  /** Schedules a pass; a pass already running is followed by one more. Returns when the queue is drained. */
  request(): Promise<void> {
    if (this.running !== undefined) {
      this.rerun = true;
      return this.running;
    }
    // Start on a microtask so `running` is set before the first measurer call —
    // a synchronous measurer (tests) could otherwise re-enter request().
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.rerun = false;
      await this.pass();
    } while (this.rerun);
  }

  private async pass(): Promise<void> {
    const pending = this.store
      .entries()
      .filter((e) => needsLoudness(e) && !this.failed.has(e.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (pending.length === 0) return;

    this.log(`loudness: measuring ${pending.length} track${pending.length === 1 ? '' : 's'} ...`);
    const started = Date.now();
    let next = 0;
    let measured = 0;
    let unpublished = 0;
    let lastPublish = Date.now();

    const publish = (): void => {
      if (unpublished === 0) return;
      this.store.bumpRev();
      this.store.schedulePersist();
      unpublished = 0;
      lastPublish = Date.now();
    };

    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const entry = pending[next++]!;
        let result: LoudnessMeasurement | undefined;
        try {
          result = await this.measure(path.join(this.musicDir, entry.path));
        } catch (err) {
          this.log(`loudness: ${err instanceof Error ? err.message : String(err)} — stopping pass`);
          next = pending.length;
          return;
        }
        if (result === undefined) {
          this.failed.add(entry.path);
          this.log(`loudness: could not measure ${entry.path}`);
          continue;
        }
        // Write back only if the entry is still the same file (not re-indexed meanwhile).
        const current = this.store.get(entry.path);
        if (current === undefined || current.contentKey !== entry.contentKey) continue;
        this.store.upsert({ ...current, loudness: result.loudness, truePeak: result.truePeak });
        measured += 1;
        unpublished += 1;
        if (Date.now() - lastPublish >= this.publishIntervalMs) publish();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
    publish();
    this.log(
      `loudness: measured ${measured}/${pending.length} in ${Date.now() - started} ms — rev ${this.store.rev}`,
    );
  }
}
