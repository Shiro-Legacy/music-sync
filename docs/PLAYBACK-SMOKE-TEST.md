# iPhone playback smoke test

Run this after the first Release install and after upgrading React Native or
`react-native-track-player`. The Simulator is useful for basic UI checks, but it
cannot validate the physical-device background and Control Center behavior that
MusicSync depends on.

## Setup

1. Pair MusicSync with the desktop server and let at least two tracks sync.
2. Keep one additional track stream-only, if possible, to exercise authenticated
   HTTP playback as well as local-file playback.
3. Open the Xcode device console (or macOS Console filtered to `MusicSync`) so a
   native crash or React Native interop warning is captured.

## Required checks

- [ ] Start a synced track. Audio starts and the mini-player shows its metadata.
- [ ] Pause and resume from the in-app mini-player.
- [ ] Seek from the full player, then skip next and previous. The queue and
      metadata follow the active track.
- [ ] Start the stream-only track. Authenticated LAN playback starts.
- [ ] Lock the iPhone. Audio continues with the screen off.
- [ ] On the Lock Screen, verify artwork/title and use pause, play, next,
      previous, and seek. Each command reaches the app exactly once.
- [ ] Open Control Center and repeat pause/play and next/previous.
- [ ] Leave MusicSync for another app for at least one minute. Playback continues,
      and returning to MusicSync shows the correct track, play state, and position.
- [ ] Interrupt playback (for example, play another audio source or receive a
      test call). MusicSync pauses; it resumes only when iOS marks the interruption
      resumable.
- [ ] Force-quit MusicSync after pausing. Relaunch it and confirm there is no crash
      while the playback service registers.

## Pass criteria

All required checks pass without a native crash, an unhandled JavaScript error, or
missing/duplicated remote-control events. React Native may emit a development-only
warning that `RNTrackPlayer` is using the TurboModule interop layer; that warning is
expected for `react-native-track-player` 4.1.2.

If a check fails, record the app build configuration, iOS version, exact step, and
the device-console excerpt before changing dependencies. In particular, distinguish
a module-registration failure at import time from a playback or remote-event failure
after `setupPlayer` succeeds.
