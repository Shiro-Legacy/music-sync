import TrackPlayer, { type AddTrack } from 'react-native-track-player';

import { authHeaders, trackUrl } from '../api/client';
import { getServerConfig, type ServerConfig, type TrackRow } from '../db/queries';
import { localArtworkUri } from '../sync/paths';

/**
 * Maps a db row to an RNTP track. Synced tracks play from the local file;
 * everything else streams from the server with auth headers (RNTP v4 Track
 * supports `headers` for remote URLs).
 */
export function toPlayerTrack(row: TrackRow, cfg: ServerConfig | null): AddTrack {
  const isLocal = row.state === 'synced' && row.localUri !== null;
  const track: AddTrack = {
    id: row.id,
    url: isLocal && row.localUri !== null ? row.localUri : cfg !== null ? trackUrl(cfg, row.id) : '',
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

/**
 * Replaces the queue with `rows` and starts playing at `startIndex`
 * (or a random order when shuffle is requested).
 */
export async function playContext(
  rows: readonly TrackRow[],
  startIndex: number,
  opts?: { shuffle?: boolean },
): Promise<void> {
  if (rows.length === 0) return;
  const cfg = getServerConfig();
  let ordered: readonly TrackRow[] = rows;
  let start = Math.max(0, Math.min(startIndex, rows.length - 1));
  if (opts?.shuffle === true) {
    ordered = shuffled(rows);
    start = 0;
  }
  await TrackPlayer.reset();
  await TrackPlayer.add(ordered.map((row) => toPlayerTrack(row, cfg)));
  // Adding to an empty RNTP queue already selects index 0; avoid a redundant native skip.
  if (start > 0) await TrackPlayer.skip(start);
  await TrackPlayer.play();
}

/** Shuffles the not-yet-played remainder of the current queue. */
export async function shuffleRemaining(): Promise<void> {
  const currentIndex = await TrackPlayer.getActiveTrackIndex();
  if (currentIndex === undefined) return;
  const queue = await TrackPlayer.getQueue();
  const upcoming = queue.slice(currentIndex + 1);
  if (upcoming.length < 2) return;
  await TrackPlayer.removeUpcomingTracks();
  await TrackPlayer.add(shuffled(upcoming));
}
