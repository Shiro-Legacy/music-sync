import TrackPlayer, { Event } from 'react-native-track-player';

import { applyTrackVolume } from './volume';

/**
 * RNTP playback service — handles lock screen / control center remote events.
 * Registered from the app entry file before the router loads.
 */
export async function playbackService(): Promise<void> {
  // Volume leveling: the player volume is global, so re-apply it for every track.
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (event) => {
    void applyTrackVolume(event.track);
  });

  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    void TrackPlayer.play();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    void TrackPlayer.pause();
  });

  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    void TrackPlayer.skipToNext();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    void TrackPlayer.skipToPrevious();
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    void TrackPlayer.seekTo(event.position);
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, (event) => {
    // Interruption (call, Siri, other audio). Pause on duck; resume when it ends
    // unless the interruption was permanent.
    if (event.paused) {
      void TrackPlayer.pause();
    } else if (!event.permanent) {
      void TrackPlayer.play();
    }
  });
}
