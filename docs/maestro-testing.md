# Maestro UI testing for the iOS app

Maestro drives the simulator by accessibility label/text instead of coordinate
taps + OCR, which is how `ds1` previously tested by hand. It removes the
cliclick coordinate-mapping, OCR, and window-occlusion pain entirely.

## Setup (one-time, already done on this Mac)

- Maestro CLI (v2.8.0) at `~/.maestro/bin/maestro`, installed via
  `curl -fsSL "https://get.maestro.mobile.dev" | bash`.
  (The `brew` cask named `maestro` is a different product — do not use it.)
- JDK: Maestro needs Java 17+. `openjdk` (26) is installed keg-only at
  `/opt/homebrew/opt/openjdk`. Source `.quad/shared/maestro-env.sh` (or export
  `JAVA_HOME` + add `~/.maestro/bin` to `PATH`) before running.

## Run a flow

```sh
source .quad/shared/maestro-env.sh
maestro test .maestro/<flow>.yaml
```

`maestro hierarchy` prints the full accessibility tree of the running app —
use it to find the exact label of any element.

## Important: use a Release build, not the dev client

The dev client (expo-dev-client) shows a dev menu/launcher that opens on taps
and makes flows flaky. Test against a **Release** simulator build, which has no
dev client and no Metro dependency:

```sh
cd app && npx expo run:ios --configuration Release --device "iPhone 17"
```

`launchApp` in the flows then goes straight to the app.

## Flows

- `.maestro/smoke-mini-player.yaml` — Songs → play → mini-player play/pause →
  skip → open full player.
- `.maestro/create-playlist.yaml` — Playlists → New Playlist → (alert + prompt)
  → assert the row appears. Doubles as the m138 create-no-refresh repro.

## Accessibility conventions added for testing

- Mini-player bar is one element `"Now playing <title> by <artist>"` (tap →
  full player); its buttons are separate `"Pause"/"Play"` and `"Next song"`
  (`app/src/ui/MiniPlayer.tsx`).
- Song rows expose `"<title>, <artist>, <badge>, <duration>"` — match with a
  regex selector, e.g. `tapOn: "Long Tone.*"`.
- Tabs expose `"<Name>, tab, <n> of 4"`; segments are `"Artists"/"Albums"/"Songs"`.

## Known limitations

- Native `Alert.alert`/`Alert.prompt` interaction is still being validated; the
  create flow exercises it. If a flow stalls on an alert, dump `maestro
  hierarchy` to see whether the alert's buttons are in the tree.
- Maestro asserts by visible text; use regex (`".*suffix"`) for labels that
  combine several fields.
