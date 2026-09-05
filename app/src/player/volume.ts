import TrackPlayer, { type AddTrack, type Track } from 'react-native-track-player';

import { getVolumeLeveling, setVolumeLeveling as persistVolumeLeveling } from '../db/queries';
import { usePlayerStore } from '../store/playerStore';
import { levelingVolume } from './loudness';

/** Loudness fields `toPlayerTrack` copies from the db row onto the RNTP track. */
export interface LeveledTrack {
  loudness?: number | null;
  truePeak?: number | null;
}

function loudnessOf(track: (Track | AddTrack | LeveledTrack) | undefined): number | null {
  const value = (track as LeveledTrack | undefined)?.loudness;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Sets the (global) player volume to the leveled value for `track`. */
export async function applyTrackVolume(
  track: (Track | AddTrack | LeveledTrack) | undefined,
): Promise<void> {
  const enabled = usePlayerStore.getState().leveling;
  try {
    await TrackPlayer.setVolume(levelingVolume(loudnessOf(track), enabled));
  } catch {
    // Player not set up (e.g. headless event before setup) — the next track change retries.
  }
}

/** Loads the persisted preference into the store. Call once at startup, after migrations. */
export function initVolumeLeveling(): void {
  usePlayerStore.setState({ leveling: getVolumeLeveling() });
}

/** Toggles leveling, persists it, and re-levels whatever is playing right now. */
export async function setVolumeLeveling(on: boolean): Promise<void> {
  usePlayerStore.setState({ leveling: on });
  persistVolumeLeveling(on);
  let active: Track | undefined;
  try {
    active = await TrackPlayer.getActiveTrack();
  } catch {
    active = undefined;
  }
  await applyTrackVolume(active);
}
