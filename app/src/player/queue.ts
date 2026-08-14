import TrackPlayer, { type AddTrack, type Track } from 'react-native-track-player';

import { authHeaders, trackUrl } from '../api/client';
import { getServerConfig, type ServerConfig, type TrackRow } from '../db/queries';
import { usePlayerStore } from '../store/playerStore';
import { localArtworkUri, resolveLocalUri } from '../sync/paths';
import { assertCapabilities } from './setup';

/**
 * Maps a db row to an RNTP track. Synced tracks play from the local file;
 * everything else streams from the server with auth headers (RNTP v4 Track
 * supports `headers` for remote URLs).
 */
export function toPlayerTrack(row: TrackRow, cfg: ServerConfig | null): AddTrack {
  const localUri = row.state === 'synced' ? resolveLocalUri(row) : null;
  const isLocal = localUri !== null;
  const track: AddTrack = {
    id: row.id,
    url: isLocal ? localUri : cfg !== null ? trackUrl(cfg, row.id) : '',
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.durationSec,
  };
  if (!isLocal && cfg !== null) {
    track.headers = authHeaders(cfg);
  }
  if (row.artworkId !== null) {
    const artwork = localArtworkUri(row.artworkId);
    if (artwork !== null) track.artwork = artwork;
  }
  return track;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

function trackId(track: Track | AddTrack | undefined): string | undefined {
  if (track === undefined) return undefined;
  const id = track.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function sameTrack(a: Track | AddTrack | undefined, b: Track | AddTrack | undefined): boolean {
  const idA = trackId(a);
  const idB = trackId(b);
  if (idA !== undefined && idB !== undefined) return idA === idB;
  return a?.url !== undefined && a.url !== '' && a.url === b?.url;
}

/** Context order from the last `playContext`, used to restore when shuffle turns off. */
let originalQueue: AddTrack[] = [];

/** Serialize RNTP queue writes so play/toggle cannot interleave. */
let mutation: Promise<void> = Promise.resolve();

function enqueue(fn: () => Promise<void>): Promise<void> {
  const run = mutation.then(fn, fn);
  mutation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function setShuffleFlag(on: boolean): void {
  usePlayerStore.setState({ shuffle: on });
}

/**
 * Rebuilds the native queue to `[current, ...upcoming]` without resetting
 * playback of the current item.
 */
async function replaceUpcoming(upcoming: readonly AddTrack[]): Promise<void> {
  const currentIndex = await TrackPlayer.getActiveTrackIndex();
  if (currentIndex !== undefined && currentIndex > 0) {
    await TrackPlayer.remove(Array.from({ length: currentIndex }, (_, i) => i));
  }
  await TrackPlayer.removeUpcomingTracks();
  if (upcoming.length > 0) await TrackPlayer.add([...upcoming]);
}

async function applyShuffleKeepingCurrent(): Promise<void> {
  const currentIndex = await TrackPlayer.getActiveTrackIndex();
  const queue = await TrackPlayer.getQueue();
  if (currentIndex === undefined || queue.length === 0) return;
  const current = queue[currentIndex];
  if (current === undefined) return;
  if (originalQueue.length === 0) originalQueue = [...queue];
  const rest = originalQueue.filter((track) => !sameTrack(track, current));
  if (rest.length === 0) return;
  await replaceUpcoming(shuffled(rest));
}

async function restoreOriginalKeepingCurrent(): Promise<void> {
  if (originalQueue.length === 0) return;
  const currentIndex = await TrackPlayer.getActiveTrackIndex();
  const queue = await TrackPlayer.getQueue();
  const current = currentIndex === undefined ? undefined : queue[currentIndex];
  if (current === undefined) return;
  const origin = originalQueue.findIndex((track) => sameTrack(track, current));
  const remaining =
    origin >= 0
      ? originalQueue.slice(origin + 1)
      : originalQueue.filter((track) => !sameTrack(track, current));
  await replaceUpcoming(remaining);
}

/**
 * Replaces the queue with `rows` and starts playing at `startIndex`.
 *
 * - `{ shuffle: true }` turns shuffle on, randomizes the whole list, and starts at 0.
 * - `{ shuffle: false }` turns shuffle off and plays in the given order.
 * - omitted `shuffle` keeps the current mode. If shuffle is already on, the
 *   selected row stays first and the rest are randomized.
 */
export async function playContext(
  rows: readonly TrackRow[],
  startIndex: number,
  opts?: { shuffle?: boolean },
): Promise<void> {
  if (rows.length === 0) return;
  return enqueue(async () => {
    const cfg = getServerConfig();
    const mapped = rows.map((row) => toPlayerTrack(row, cfg));
    originalQueue = mapped;

    let ordered: readonly AddTrack[] = mapped;
    let start = Math.max(0, Math.min(startIndex, mapped.length - 1));

    if (opts?.shuffle === true) {
      setShuffleFlag(true);
      ordered = shuffled(mapped);
      start = 0;
    } else if (opts?.shuffle === false) {
      setShuffleFlag(false);
    } else if (usePlayerStore.getState().shuffle) {
      const selected = mapped[start]!;
      ordered = [selected, ...shuffled(mapped.filter((_, i) => i !== start))];
      start = 0;
    }

    await TrackPlayer.reset();
    await TrackPlayer.add([...ordered]);
    // Adding to an empty RNTP queue already selects index 0; avoid a redundant native skip.
    if (start > 0) await TrackPlayer.skip(start);
    await TrackPlayer.play();
    // Now that a current track exists, re-assert remote-control capabilities —
    // the startup application is a no-op while the queue is empty.
    await assertCapabilities();
  });
}

/**
 * Toggles shuffle mode. The button always updates its visual state; the queue
 * is rewritten around the current track when one exists.
 *
 * On: keep the current track playing and randomize every other item from the
 * original context (including already-played tracks), so shuffle still does
 * something on the last song.
 * Off: restore the leftover original context order after the current track.
 */
export async function toggleShuffle(): Promise<void> {
  const next = !usePlayerStore.getState().shuffle;
  setShuffleFlag(next);
  return enqueue(async () => {
    // A later playContext may have already applied the desired mode.
    if (usePlayerStore.getState().shuffle !== next) return;
    try {
      if (next) await applyShuffleKeepingCurrent();
      else await restoreOriginalKeepingCurrent();
    } catch (error) {
      if (usePlayerStore.getState().shuffle === next) setShuffleFlag(!next);
      throw error;
    }
  });
}

/**
 * Stops playback and empties the queue (mini player swipe-dismiss). Clears the
 * saved context and shuffle mode so the next playContext starts fresh.
 */
export async function clearQueue(): Promise<void> {
  setShuffleFlag(false);
  return enqueue(async () => {
    originalQueue = [];
    await TrackPlayer.reset();
  });
}
