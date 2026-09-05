# MusicSync — personal iPhone music player that mirrors your desktop library

A two-part personal system:

- **`server/`** — a small Node.js app that runs on the Windows desktop where your music lives. It watches your music folder, indexes tags/artwork, and serves the library over your home Wi-Fi (bearer-token protected, LAN-only).
- **`app/`** — an iPhone app (Expo / React Native) that pairs with the server by scanning a QR code, **automatically downloads your whole library for offline playback**, and is a full music player (background audio, lock-screen/Control Center/AirPods controls).
- **`shared/`** — the contract between them: manifest schema, API routes, and the sync-diff algorithm (fully unit-tested).

How syncing works: the server publishes a manifest of every track (id + content hash + tags). On every app open / Wi-Fi reconnect / manual refresh — plus an opportunistic iOS background task — the app diffs the manifest against its local library and downloads what's new or changed via background URLSession (downloads keep running when you leave the app). Desktop renames are detected by content hash and become local file moves, not re-downloads. Deletions mirror to the phone, with a safety valve: a change that would delete >25% of a >100-track library waits for one-tap confirmation.

## Repo layout

```
shared/   manifest + protocol schemas, computeSyncPlan() diff (vitest-tested)
server/   Fastify server: indexer, chokidar watcher, Range streaming, QR pairing
app/      Expo SDK 57 app: expo-router UI, react-native-track-player, background downloader
```

## Running the server (Windows desktop, where the music is)

Install ffmpeg first so the server can measure loudness for [volume leveling](#volume-leveling) (`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on Mac; it must be on `PATH`). Without it everything still works, just without leveling.

```bash
npm install
npm run server -- --music-dir "D:\Music"
```

First run prints a QR code and pairing token. Scan the QR with the app's pairing screen. Useful flags: `--pair` (re-print the QR), `--status`, `--port`. To start automatically at login: `server/scripts/install-autostart.ps1`.

When Windows Firewall prompts on first listen, allow access on **Private** networks. Tip: give the desktop a DHCP reservation in your router so its IP (baked into the pairing) doesn't drift.

## Multiple people on one server

MusicSync can host multiple isolated libraries from one server process. Each library has its own music folder, pairing token, server identity, and index, so a phone paired to one library cannot browse or download another library. Existing single-library configurations migrate automatically; the existing token and phone pairing continue to work.

Add a library and print its pairing information:

```bash
npm run server -- --add-library alice --music-dir "D:\\Music\\Alice"
npm run server -- --pair --library alice
```

Repeat `--add-library` for each person. Scan each person's QR code with their phone. Use these commands to inspect or manage libraries:

```bash
npm run server -- --status
npm run server -- --remove-library alice
```

`--remove-library` removes only the library from the server configuration; its music and index files are left untouched. With multiple libraries, pass `--library <name>` when pairing or changing a music directory. A bare `--music-dir` remains supported when the server has exactly one library.

## Building the app (Mac)

Day-to-day TypeScript/UI work runs anywhere; anything iOS-native needs the Mac.

```bash
git clone <this repo> && cd <repo>
npm install
cd app
npx expo prebuild -p ios --clean     # generates ios/ (not committed)
npx expo run:ios                     # Simulator, for UI work
npx expo run:ios --device --configuration Release   # install on the iPhone
```

First device install only: open `app/ios` in Xcode once and set Signing → Team to your Personal Team for both targets, then on the iPhone trust the certificate (Settings → General → VPN & Device Management).

**Free Apple ID note:** the signing profile expires every **7 days** — the app stops launching until you rerun the Release install (same one-liner, ~5 min; your synced music survives because the bundle ID is unchanged). The Settings screen shows build age and warns after day 5. Joining the Apple Developer Program ($99/yr) extends this to a year and unlocks cloud builds (EAS) with no Mac in the loop.

There are two app variants (`APP_VARIANT=dev` → `com.jiaqi.musicsync.dev` with a dev client for Metro; default → the standalone Release app you actually use).

Testing on the Simulator: the Simulator shares the Mac's network, so it can reach the Windows server directly. Background downloads, background audio, and BGTaskScheduler behavior need the physical iPhone.

## Local playlists

The iPhone app includes local-only playlists in the **Playlists** tab. Create, rename, or delete a playlist. New Playlist can start empty or fill with songs that are in no playlist yet. Search your library to add songs that are not already in that playlist, or add every matching song at once. Remove songs, then play or shuffle using the same offline-first player as the main library. Playlist data is stored on the phone and is not sent to the desktop server.

Playlists keep their records when the local library is wiped, but their song entries are removed with the corresponding local track rows; sync can repopulate the library afterward.

## Volume leveling

Every song plays at the same loudness, replacing the LocalMusic pipeline that re-encoded files with ffmpeg `loudnorm`. Files are never rewritten; the server measures and the phone applies the gain.

- **Server** (`server/src/loudness.ts`): after every scan and watcher change, a background pass measures each playable track that has no `loudness` yet with `ffmpeg -af ebur128=peak=true` (two at a time, a few seconds per track) and writes EBU R128 integrated `loudness` (LUFS) and `truePeak` (dBTP) into the index and manifest. Serving never waits for it: partial results are published as a rev bump at most once a minute plus one at the end. A re-indexed file (size/mtime changed) is re-measured. Files ffmpeg cannot read are skipped until the next server start. `--status` shows coverage as `measured/playable`.
- **Phone** (`app/src/player/loudness.ts`, `volume.ts`): the loudness rides on each player track, and every track change sets the player volume to `10^((-18 - loudness) / 20)`, clamped to 1. That is the LocalMusic target of -14 LUFS minus 4 dB of headroom: a volume control can only attenuate, and a survey of the real libraries (median -9 LUFS, 5th percentile -17) showed 4 dB fully levels ~97% of tracks. So a -8 LUFS track plays at 0.32, a -18 LUFS track at 1.0, unmeasured tracks are treated as -14, and the whole library comes out ~4 dB quieter than raw playback — turn the phone up once. Settings → Playback → **Volume leveling** turns it off (kv `volumeLeveling`) and re-levels the current track immediately.
- **Why not rewrite the audio like LocalMusic did:** its players were third-party, so the bytes had to change. Here the player is ours, so measuring (ReplayGain-style) keeps files byte-identical: no generation loss on lossy rips, lossless stays lossless, track ids and content keys do not move, and enabling leveling on an existing library costs one manifest refresh instead of re-downloading everything. Revisit `HEADROOM_DB` if the library drifts much quieter than -18 LUFS (re-survey with `ffmpeg -af ebur128`). Album-aware leveling (one shared gain per album) is not implemented; the libraries are single rips without album tags.

## Development

```bash
npm test              # vitest: shared diff suite + server suite (incl. loudness) + app suite (queue, playlists, leveling)
npm run typecheck     # tsc across workspaces
npm run server        # tsx watch mode
cd app && npx expo start   # Metro for the dev-client variant
```

## iOS reality check (why sync is designed foreground-first)

iOS does not let apps freely run in the background at arbitrary times. Sync triggers are: app open, Wi-Fi regained, manual refresh, and an OS-scheduled `BGTaskScheduler` task that iOS typically runs overnight/charging — a top-up, not the backbone. In-flight downloads continue in the background via `URLSession` regardless. Practical result: open the app on home Wi-Fi and new music lands; anything unfinished completes on its own.

## Pushing to GitHub (one-time)

Create a **private** repo on github.com, then:

```bash
git remote add origin git@github.com:<you>/music-sync.git
git push -u origin main
```
