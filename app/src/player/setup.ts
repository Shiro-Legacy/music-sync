import TrackPlayer, { Capability, IOSCategory } from 'react-native-track-player';

let ready = false;

/**
 * Capability enum values are read from the legacy native module's exported
 * constants at JS load time; fall back to the raw iOS capability strings
 * (ios/RNTrackPlayer/Models/Capabilities.swift) if the new-arch interop
 * delivers them undefined.
 */
function cap(value: Capability | undefined, iosName: string): Capability {
  return value ?? (iosName as unknown as Capability);
}

const CAPABILITIES = [
  cap(Capability.Play, 'play'),
  cap(Capability.Pause, 'pause'),
  cap(Capability.SkipToNext, 'next'),
  cap(Capability.SkipToPrevious, 'previous'),
  cap(Capability.SeekTo, 'seek'),
];

/**
 * (Re-)applies the remote-control capabilities. SwiftAudioEx only pushes
 * commands to MPRemoteCommandCenter when a current track exists, so the
 * startup call alone is a silent no-op on an empty queue — this must be
 * called again once the queue has loaded (see playContext) or the Lock
 * Screen / Control Center controls stay disabled.
 */
export async function assertCapabilities(): Promise<void> {
  await TrackPlayer.updateOptions({ capabilities: CAPABILITIES });
}

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
  await assertCapabilities();
  ready = true;
}
