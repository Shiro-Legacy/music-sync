import TrackPlayer, { Capability, IOSCategory } from 'react-native-track-player';

let ready = false;

/** Initializes the player exactly once per JS lifetime. Safe to call repeatedly. */
export async function setupPlayerOnce(): Promise<void> {
  if (ready) return;
  try {
    await TrackPlayer.setupPlayer({ iosCategory: IOSCategory.Playback });
  } catch (e) {
    // Already initialized (e.g. after a fast refresh) — that's fine.
    const message = e instanceof Error ? e.message : String(e);
    if (!message.toLowerCase().includes('already')) throw e;
  }
  await TrackPlayer.updateOptions({
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
      Capability.SeekTo,
    ],
  });
  ready = true;
}
