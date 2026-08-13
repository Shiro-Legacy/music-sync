import TrackPlayer, { Event } from 'react-native-track-player';

/**
 * RNTP playback service — handles lock screen / control center remote events.
 * Registered from the app entry file before the router loads.
 */
export async function playbackService(): Promise<void> {
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
