import { useMemo } from 'react';
import { useActiveTrack } from 'react-native-track-player';

import { byId } from '../db/queries';
import { usePlayerStore } from '../store/playerStore';

/** RNTP metadata updates do not emit active-track changes on iOS. */
export function useCurrentTrack() {
  const track = useActiveTrack();
  const version = usePlayerStore((state) => state.metadataVersion);
  return useMemo(() => {
    const row = typeof track?.id === 'string' ? byId(track.id) : null;
    return row === null || track === undefined
      ? track
      : { ...track, title: row.title, artist: row.artist };
  }, [track, version]);
}
