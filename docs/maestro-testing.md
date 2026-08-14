# Maestro UI testing for the iOS app

Maestro drives the simulator by accessibility label/text instead of coordinate
taps + OCR. It removes the cliclick coordinate-mapping, OCR, and window-occlusion
pain entirely.

## Setup (one-time)

- **Maestro CLI** (v2.8.0): `curl -fsSL "https://get.maestro.mobile.dev" | bash`
  installs to `~/.maestro/bin`. (The `brew` cask named `maestro` is a different
  product — do not use it.)
- **Java 17+**: `brew install openjdk` (keg-only at `/opt/homebrew/opt/openjdk`).
  The runner discovers it automatically via `JAVA_HOME` → system `java` →
  homebrew openjdk.

## Run a flow

```sh
# all flows in .maestro/
scripts/test-maestro-ios.sh

# one flow, with a specific device
scripts/test-maestro-ios.sh --device "iPhone 17" --flow .maestro/smoke-mini-player.yaml
```

The runner resolves Java, Maestro, and a booted simulator, and passes a
unique `NAME` so the create flow cannot false-pass on a leftover row.
Manual invocation (no runner):

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
maestro test -e NAME="<unique>" .maestro/create-playlist.yaml
```

`maestro hierarchy` prints the full accessibility tree of the running app —
use it to find the exact label of any element.

## Important: use a Release build, not the dev client

The dev client (expo-dev-client) shows a dev menu/launcher that opens on taps
and makes flows flaky. Test against a **Release** simulator build:

```sh
cd app && npx expo run:ios --configuration Release --device "iPhone 17"
```

`launchApp` in the flows then goes straight to the app.

## Flows

- `.maestro/smoke-mini-player.yaml` — Songs → play → mini-player play/pause →
  skip → open full player (asserts the full player's `"Close player"` marker).
- `.maestro/create-playlist.yaml` — Playlists → New Playlist → (alert + prompt)
  → asserts the row appears; doubles as the m138 no-refresh repro.

## Accessibility conventions added for testing

- Mini-player bar is one element `"Now playing <title> by <artist>"` (tap →
  full player); its buttons are separate `"Pause"/"Play"` and `"Next song"`
  (`app/src/ui/MiniPlayer.tsx`).
- Full player dismiss control is `"Close player"` (`app/app/player.tsx`).
- Song rows expose `"<title>, <artist>, <badge>, <duration>"` — match with a
  regex selector, e.g. `tapOn: "Long Tone.*"`.
- Playlist rows expose `"<name>, N songs · M min, ›"` or `"… M hr, ›"` — match with
  `"<name>.*"`, never an exact name.
- Tabs expose `"<Name>, tab, <n> of 4"`; segments are `"Artists"/"Albums"/"Songs"`.

## Known limitations

- Native `Alert.alert`/`Alert.prompt` interaction is exercised by the create
  flow. If a flow stalls on an alert, dump `maestro hierarchy` to see whether
  the alert's buttons are in the tree.
- Maestro asserts by visible text; use regex (`".*suffix"` / `"prefix.*"`) for
  labels that combine several fields.
