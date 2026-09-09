# MusicSync

Personal iPhone music player that mirrors a desktop library over home Wi-Fi.

**This file is the static product document.** It explains what MusicSync is and how to build, run, and test it — nothing personal, nothing that changes between sessions. If another markdown file disagrees with it on product behavior, this file wins. When behavior, protocol, schema, CLI, playback, sync, playlists, build, or tests change, update the matching section here in the same change. Do not add new markdown for product knowledge.

Mutable deployment state (devices, libraries, backlog, signing identity) lives in `DEPLOYMENT.md`, which is **gitignored** — it never goes to GitHub. `.quad/` is gitignored session scratch, not documentation. Agent process rules live in `AGENTS.md` (loaded by coding agents; `CLAUDE.md` imports it).

## Contents

1. [What it is](#what-it-is)
2. [Domain vocabulary](#domain-vocabulary)
3. [Repo layout](#repo-layout)
4. [Protocol](#protocol)
5. [Server](#server)
6. [App](#app)
7. [Sync](#sync)
8. [Playback](#playback)
9. [Playlists](#playlists)
10. [Multiple libraries](#multiple-libraries)
11. [Run the server](#run-the-server)
12. [Build the app (Mac)](#build-the-app-mac)
13. [Testing](#testing)
14. [Decisions](#decisions)
15. [Library hygiene](#library-hygiene)
16. [Lessons](#lessons)
17. [Not in product](#not-in-product)

## What it is

A two-part personal system:

- **`server/`** — Node.js app on the machine where the music lives. Watches the music folder, indexes tags/artwork, and serves the library over LAN (bearer-token protected).
- **`app/`** — iPhone app (Expo / React Native). Pairs by scanning a QR code or typing host, port, and token; downloads the library for offline playback; and is a full music player (background audio, Lock Screen / Control Center / AirPods).
- **`shared/`** — the contract: manifest schema, API routes, and `computeSyncPlan()` (unit-tested).

iOS does not let apps freely run in the background. Sync triggers are app open, Wi-Fi regained, manual refresh, and an OS-scheduled `BGTaskScheduler` task (typically overnight/charging — a top-up, not the backbone). In-flight downloads continue via `URLSession` when you leave the app. Practical result: open the app on home Wi-Fi and new music lands; unfinished downloads complete on their own.

## Domain vocabulary

Glossary only. Implementation details live in later sections.

### Library

A music folder the server indexes and a paired phone mirrors. One server process can host several isolated libraries; a phone paired to one library cannot see another.

### Track

One audio file in a library, published with tags, duration, and two identities: a location identity and a bytes identity.

### Track identity (`id`)

Stable id for a track's location: SHA-1 of the relative path from the music root, using forward slashes. Renaming or moving the file mints a new identity and retires the old one.

### Content key

Identity of the file bytes: SHA-1 of the first 64 KB + last 64 KB + ASCII file size (files under 128 KB hash the whole file + size once). Tag edits, re-encodes, and replacements change the content key even when the path (and therefore the track identity) stays the same.

Casual talk of "id" can mean either. They are distinct. A tag edit changes the content key and keeps the track identity.

### Manifest

The server's published snapshot of a library: server identity, a monotonic revision, and every track's identities plus tags. The phone diffs this against its local copy to decide what to download, move, or delete.

### Rename rescue

When a desktop file is renamed, the old path disappears and a new path appears with the same content key. Sync moves the already-downloaded local file to the new identity instead of deleting it and downloading again. Only fully `synced` local files are eligible.

### Unknown Artist

The artist string the indexer publishes when a file has no artist tag. It is a fallback display value, not a real artist.

### Loudness

Per-track EBU R128 integrated loudness (LUFS) and true peak (dBTP), measured by the server with ffmpeg and published in the manifest. The phone turns it into a playback gain so every song plays at the same level. Absent until measured, or when the server has no ffmpeg.

### Server identity (`serverId`)

Per-library UUID minted at first run / `--add-library`. The app pins it at pairing and refuses manifests from a different identity.

## Repo layout

npm workspaces. Always `npm install` at the **repo root**, never inside `app/`.

```
shared/    manifest + protocol schemas, computeSyncPlan()  (vitest)
server/    Fastify: indexer, chokidar watcher, Range streaming, QR pairing
app/       Expo SDK 57 app: expo-router UI, RNTP, background downloader
app/modules/backup-exclusion/  local Expo module (autolinked pod) that excludes Music/ and Artwork/ from iCloud backup
tools/     throwaway library fixtures + HTTP protocol smoke
scripts/   Maestro iOS runner
.maestro/  Maestro flows (Release simulator, not the dev client)
```

`app/ios/` is gitignored and generated by `npx expo prebuild`. Never hand-edit it expecting it to survive. Native configuration lives in `app/app.config.ts`.

## Protocol

Defined in `shared/src/`. Default port **5299**. API version 1.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/ping` | optional bearer | Pairing diagnostics. With a valid token, `serverId` is that library's; otherwise the first library's. |
| `GET /api/v1/manifest` | required | ETag `"rev-N"`; `If-None-Match` → 304. |
| `GET /api/v1/tracks/:id` | required | Range requests; ETag is the content key; `If-Match` → 412 on mismatch. Path is never derived from user input — lookup by id only. |
| `PATCH /api/v1/tracks/:id/metadata` | required | `{ title, artist }` → `{ serverId, id, title, artist }`. Requires matching `X-MusicSync-Server-Id` and `If-Match` content key; edits MusicSync metadata, never audio bytes. |
| `GET /api/v1/artwork/:artworkId` | required | 40-hex SHA-1 only; immutable cache. |
| `POST /api/v1/imports/preview` | required | `{ url }` → `{ serverId, preview }` with suggested tags, duration, thumbnail. YouTube single-video links only. |
| `POST /api/v1/imports` | required | `{ url, title, artist }` → `{ serverId, job }`; accepts a durable background import, or returns the existing job/track for that video. |
| `GET /api/v1/imports` | required | `{ serverId, available, unavailableReason?, jobs }`; recent jobs for the authenticated library only. |

Import routes additionally require `X-MusicSync-Server-Id` to match the paired library identity (409 otherwise). Bodies are strictly validated; clients cannot select a library, filesystem path, or downloader arguments. Errors use `{ error }`. Import schemas live in `shared/src/imports.ts`.

Metadata PATCH bodies are strict: title and artist are trimmed, nonempty, at most 300 characters each, with no control characters. Missing/wrong identity → 409; missing byte precondition → 428; changed bytes → 412; unknown track → 404. Accepted overrides are persisted before success; repeated identical edits are safe. Schemas live in `shared/src/metadata.ts`.

Every request is LAN-only (loopback, RFC1918, link-local, IPv6 ULA/link-local). Non-LAN → 403. Missing/wrong bearer on authenticated routes → 401. Token compare is timing-safe SHA-256 digest match against each library.

QR payload (`v: 1`): `{ host, port, token, name }`. `name` is the **host** name, not the library name.

Playable formats (AVPlayer-native): `mp3`, `flac`, `m4a`, `alac`, `aac`, `wav`, `aiff`. Indexed but marked `unsupported`: `ogg`, `opus`, `wma`, `mka`, `webm`. The phone only syncs playable tracks.

## Server

Config and indexes live in `~/.music-sync/` (override with `MUSIC_SYNC_DATA_DIR`).

```
~/.music-sync/config.json          v2: port, host name, libraries[]
~/.music-sync/index-<name>.json    per-library track index
~/.music-sync/overrides-<name>.json  durable title/artist edits (not a rebuildable cache)
~/.music-sync/artwork/             shared, content-addressed artwork
```

Each library has `name` (`[a-z0-9][a-z0-9-]*`), `musicDir`, `token`, `serverId`. v1 configs (no `v` field) migrate automatically to one library named `default`, keeping token and serverId so existing pairings survive. Legacy `index.json` is renamed to `index-default.json`.

Indexer: reuse an existing entry when size + mtime are unchanged; otherwise recompute content key and tags (and drop the loudness, which is re-measured). Missing artist → `Unknown Artist`; missing title → filename stem. `.m4a` with an ALAC codec is published as `alac`. Watcher is chokidar. Track bytes are streamed with Range; gzip is not applied to track/artwork (it would break Range).

Loudness (`server/src/loudness.ts`): after every scan and watcher change, a background pass measures each playable track that has no `loudness` yet with `ffmpeg -af ebur128=peak=true` (two at a time, a few seconds per track) and writes `loudness` / `truePeak` into the entry. Serving never waits for it: the manifest is published immediately, partial results are pushed as a rev bump at most once a minute, and one final bump when the pass ends. ffmpeg is optional — without it the server warns once and tracks simply have no loudness. Files ffmpeg cannot read are skipped until the next server start. `--status` shows coverage as `measured/playable`.

`--remove-library` drops the library from config only. Music files and the index file stay on disk. The last library cannot be removed.

### Song metadata edits

The phone saves title/artist edits offline, then uploads them on the next reachable sync. The desktop keeps per-library overrides in `overrides-<name>.json` and publishes them in the manifest. Audio tags, filenames, content keys, and loudness measurements stay unchanged, so edits do **not** re-download audio. Other music apps reading the files still see their original tags.

Overrides are keyed by track id and guarded by content key: scans/restarts preserve them, but renaming a desktop file or changing its bytes retires the override. Duplicate files at different paths can be edited independently. Last server-accepted edit wins between phones; no conflict-merging UI. A corrupt override file is preserved and disables further edits with an error, not silently overwritten.

### YouTube imports

The phone can request a song on the paired desktop; the server runs **yt-dlp**, not Stacher. The desktop remains the source of truth. Existing Stacher/manual imports keep working unchanged. Submission requires reaching the running server over LAN; an accepted job continues when the phone closes, provided the server keeps running.

- Library → **Import from YouTube**: paste a video link, preview thumbnail/duration, correct title and artist, then add. Suggestions are not authoritative music metadata. Tags are written into the audio file before indexing.
- YouTube/YouTube Music watch links, Shorts, embeds, and `youtu.be` links are normalized to one video ID; playlist parameters are discarded. Playlist-only links, other sites, livestreams, and videos longer than 30 minutes are rejected. First version has no search, bulk import, browser cookies, or iOS Share extension.
- Prefer native AAC/M4A (`bestaudio[ext=m4a]/bestaudio`); only convert fallback audio to AAC/M4A when necessary. Converting lossy audio does not improve quality. No baked-in loudness normalization: the existing server measurement and player gain still apply. Existing `.opus` files remain unsupported and are not converted automatically.
- Work happens under `<musicDir>/.music-sync-imports/<job-id>/`, ignored by both startup scanning and the watcher. Only validated, fully tagged audio is published as `YouTube/<video-id>.m4a`, using an atomic no-overwrite hard link on the same filesystem. The music volume must support hard links (e.g. APFS or NTFS; not exFAT). Titles do not control paths; correcting tags does not change track identity. A job becomes `ready` only after indexing, without waiting for loudness measurement.
- One active download across the server, a bounded queue of 10, 100 MiB staging/output limit, 30-second preview timeout, 10-minute import timeout. Subprocesses use fixed arguments without a shell; user CLI config/plugins are disabled. Only canonical YouTube URLs reach yt-dlp.
- Jobs persist in `~/.music-sync/imports-<name>.json` (under `MUSIC_SYNC_DATA_DIR` when overridden). Recent terminal history is bounded to 100 jobs; pending work is retained. On restart, published files are reconciled and interrupted work is exposed for explicit retry. Corrupt job state is not silently discarded.
- Same video ID is deduplicated within a library; separate libraries can import the same video independently. Re-submitting an existing import does not rewrite its tags. Old Stacher files without source IDs cannot reliably be recognized as duplicates; no fuzzy title-based deletion or replacement.
- Job states: `queued`, `downloading`, `processing`, `indexing`, `ready`, `failed`. Desktop `ready` means **Added to library**, not **Available offline**: the latter requires a successfully synced local file. The import screen polls only while focused and foregrounded, then uses the existing sync engine.

**Server tools:** install **yt-dlp 2026.08.19 or newer**, `ffmpeg`, and `ffprobe` on the server machine, not the phone. The official standalone yt-dlp executable includes EJS; full YouTube support also needs a supported JavaScript runtime, explicitly supplied from the server's Node executable. An incomplete tool installation disables importing with an actionable message, not library serving/playback. Keep yt-dlp updated independently of MusicSync: YouTube changes can break extraction. On macOS, use `brew install yt-dlp ffmpeg` and `brew upgrade yt-dlp`; for an official Windows standalone executable, put it on `PATH` and use `yt-dlp -U` to update. `MUSIC_SYNC_YTDLP_PATH` can override the executable location. Download only material you are authorized to save.

## App

Expo SDK 57, React Native 0.86.2, iOS only.

Two variants, selected by `APP_VARIANT` in `app/app.config.ts`:

| | Release (default) | Dev (`APP_VARIANT=dev`) |
|---|---|---|
| Name | MusicSync | MusicSync (Dev) |
| Bundle id | `com.jiaqi.musicsync` | `com.jiaqi.musicsync.dev` |
| JS | embedded Release bundle | Metro / expo-dev-client |

`ios/` holds **one variant at a time**. Switching variants means a clean prebuild with the right env var. The signing team (Personal Team, 7-day free profiles) comes from `APPLE_TEAM_ID` in `app/.env.local` (gitignored; Expo CLI loads it automatically).

### Navigation

Root stack (`app/app/_layout.tsx`): `(tabs)`, full-screen `/player` modal (gestures off — a sheet pull-down cancels seek-bar drags), `/pair` modal. Migrations run at module load before any screen touches SQLite.

Tabs: **Library** (Artists / Albums / Songs), **Playlists**, **Sync**, **Settings**. Library detail routes live on the root stack: `/library/artist/[artist]`, `/library/album/[key]`, `/library/playlist/[id]`, `/library/playlist/[id]/add`, `/library/playlist/[id]/copy` (destination picker), `/library/song/[id]/edit` (title/artist editor), and `/library/import` (YouTube preview/add and recent import jobs).

Mini player mounts once in the root layout. Visible on tab routes and `/library/*` when a track is loaded and not dismissed. Hidden on `/player` and `/pair`. Swipe left clears the queue. Tap the bar (not its buttons) opens the full player. Play/pause and skip-next are nested pressables.

### Database

`expo-sqlite`, WAL, `PRAGMA foreign_keys = ON`. `MIGRATIONS` is append-only; `PRAGMA user_version` tracks how many have run.

1. `tracks` + `kv` (pairing, ETag/rev, held deletions).
2. `playlists` + `playlist_tracks` (PK `(playlistId, trackId)` — a track appears at most once per playlist; `ON DELETE CASCADE` from both playlist and track).
3. Server loudness / true-peak columns on `tracks`.
4. `pending_metadata` outbox: library identity, track id, original content key, edited title/artist, generation. The row edit and outbox write are atomic; deletion of the track cascades to its queued edits. `kv.trackLibraryServerId` prevents editing a previous library's rows while a new pairing is awaiting its first manifest.

Library data and playlists live in SQLite, not Zustand. Zustand holds live sync progress (`syncStore`) and player chrome flags (`playerStore`: `shuffle`, `dismissed`). Screens refresh on focus; after mutations bump local state so memoized queries rerun.

Wiping the local library deletes track rows (cascade removes playlist entries) but keeps pairing metadata and playlist records.

### Storage

Downloaded audio lives in `Documents/Music/<id>.<ext>` and artwork in `Documents/Artwork/<artworkId>`. Both directories are excluded from iCloud backup. The SQLite `localUri` column records the absolute file URI at download time, but iOS rotates the app-container UUID on reinstall, so that prefix goes stale — playback always resolves `<id>.<ext>` against the current container (`resolveLocalUri` in `app/src/sync/paths.ts`). A same-bundle-id re-sign or update keeps the library; deleting the app does not.

## Sync

**Metadata uploads precede manifest downloads.** Long-press a song in the library or a playlist → **Edit Song** → edit title/artist → **Save**. The phone updates immediately, attempts sync, and retains edits across offline use/relaunch. The Sync tab shows edits waiting to upload and errors. Existing app-open, Wi-Fi-reconnect, manual, and OS background triggers retry them; merely being on Wi-Fi is not a guarantee of immediate iOS background execution.

Pending title/artist edits overlay manifest tags while the file's content key still matches, until their matching generation is acknowledged; a late response cannot clear a newer edit. Uploads and acknowledgments are scoped to the paired server identity. A replaced desktop file returns 412: the library shows the replacement's tags, while Edit Song keeps the unsent draft and warns before applying it to the new bytes. Review and save again to confirm. Upload conflicts appear on the Sync tab without blocking library downloads. Missing desktop songs follow normal deletion/held-deletion rules. Wiping the local library also discards unsent edits. An older desktop server cannot accept edits: they remain on the phone until the server is updated and sync is retried.

`shared/src/diff.ts` → `computeSyncPlan(manifestTracks, localTracks)`:

- same id, different content key → re-download
- known id, not `synced` → re-enqueue
- new id with a synced local file of the same content key → **rename rescue** (move)
- otherwise new id → download
- local id absent from manifest and not rescued → delete

Mass-delete valve: if the local library has more than 100 tracks and the plan would delete more than 25%, `deletionsHeld` is true. Downloads and moves still apply; deletions wait for one-tap confirm (`applyHeldDeletions`) or dismiss.

Triggers (`app/src/sync/triggers.ts`, `background.ts`):

- foreground (app active), throttled to 60s
- Wi-Fi reconnect
- manual refresh
- `BGTaskScheduler` (`music-sync-background`, minimumInterval 60 — iOS decides when)

Downloads use `@kesha-antonov/react-native-background-downloader` (URLSession). A track fails after 3 errors. Artwork is fetched separately into the app container.

## Playback

`react-native-track-player` **4.1.2** via RN 0.86's legacy NativeModule interop. iOS only. See [Decisions](#decisions).

- Entry (`app/index.ts`) registers the playback service **before** expo-router loads.
- `setupPlayerOnce` uses `IOSCategory.Playback` and capabilities play / pause / next / previous / seek. Capabilities must be re-asserted after the queue has a current track (`assertCapabilities` from `playContext`) or Lock Screen controls stay dead.
- `playContext(rows, index, { shuffle? })` is the only queue boundary. It resets RNTP, maps rows (`synced` → local file, else authenticated LAN URL), then plays. Adding to an empty queue already selects index 0 — do not `skip(0)`.
- Shuffle is a persistent mode in `playerStore`. On: keep current, randomize the rest of the original context (including already-played, so shuffle still does something on the last song). Off: restore leftover original order after the current track. Queue writes are serialized (`enqueue`) so play/toggle cannot interleave.
- Repeat cycles Off → Queue → Track on the full player.
- The full player's square artwork fits the height left after metadata, seek bar, and transport controls, rather than using screen width alone. The iPhone SE's controls stay inside the bottom safe area.
- Title/artist edits refresh the mini/full player, native queue/Lock Screen metadata, and saved shuffle context without restarting playback. `useCurrentTrack` reads current database labels because RNTP's metadata-update call does not emit an active-track event.
- Remote events (Lock Screen / Control Center / interruption duck) live in `app/src/player/service.ts`.
- **Volume leveling** (`app/src/player/loudness.ts`, `volume.ts`): the loudness the server measured rides on each RNTP track (`toPlayerTrack`), and `PlaybackActiveTrackChanged` sets the player volume to `10^((-18 - loudness) / 20)`, clamped to 1. Target is -14 LUFS (LocalMusic parity) minus 4 dB headroom: a volume control can only attenuate, and a survey of the real libraries (533 tracks, median -9.4 LUFS, 5th percentile -17.3) showed 4 dB fully levels 97% of tracks. A -8 LUFS track plays at 0.32, a -18 LUFS track at 1.0, unmeasured tracks are treated as -14, and the whole library comes out ~4 dB quieter than raw playback. `playContext` levels the first track before `play()`. Settings → Playback → Volume leveling toggles it (kv `volumeLeveling`, default on) and re-levels the current track immediately.
- `UIBackgroundModes: ['audio']`. Local Network permission is required to reach the server (`NSAllowsLocalNetworking` for cleartext LAN HTTP).

## Playlists

Local-only. Never sent to the server.

- Create / rename / delete. **＋ New Playlist** offers Empty playlist, or Add unsorted songs when any track is in no playlist (default name `Unsorted`).
- Listed in creation order (new at the bottom). Subtitle is `N songs · M min` under an hour, `N songs · X hr` at ≥ 1 hour.
- Detail: play / shuffle via `playContext` in displayed order; add songs (search + multi-select + **Add all (N)** of the current filter; confirm when N > 50); long-press a row for **Copy to playlist**, **Edit Song**, or **Remove**. Copy chooses another existing playlist, keeps the song in the source, and appends it to the destination without duplicating an existing entry or audio file. Already-in-playlist tracks are excluded from Add Songs. Inserts `INSERT OR IGNORE` and append after `MAX(position)`.
- Unsorted = `NOT EXISTS` against `playlist_tracks`, ordered `title COLLATE NOCASE` like the Songs tab. A song in any playlist is not unsorted.
- After `Alert.prompt` create/rename, refresh immediately **and** again after 400ms. Device-only: iOS 18 can swallow a repaint that lands during keyboard/alert teardown. The simulator does not reproduce this. See [Lessons](#lessons).

## Multiple libraries

One process, N isolated libraries. A token only ever sees its own library. Track ids can collide across libraries (id = SHA-1 of relative path) — lookup is always per-library.

```bash
npm run server -- --add-library alice --music-dir "D:\\Music\\Alice"
npm run server -- --pair --library alice
npm run server -- --status
npm run server -- --remove-library alice
```

With more than one library, `--pair` and `--music-dir` require `--library <name>`. A bare `--music-dir` still works when there is exactly one.

The root `npm run server` wrapper goes through `tsx watch` and has mangled library flags (`--add-library` dropped, process hangs). For any flagged invocation use `npm -C server start -- <flags>`. `--pair` is safe while a server is already running: it prints the QR and exits without binding the port.

## Run the server

Where the music lives (Windows desktop or any machine on the LAN). Install ffmpeg first for volume leveling (`brew install ffmpeg` on Mac, `winget install Gyan.FFmpeg` on Windows; it must be on `PATH`):

```bash
npm install
npm run server -- --music-dir "D:\Music"
```

First run prints a QR and pairing token. Scan it from the app's pairing screen. Useful flags: `--pair` (re-print QR), `--status`, `--port`. Windows autostart at login: `server/scripts/install-autostart.ps1`.

When Windows Firewall prompts, allow **Private** networks. Give the desktop a DHCP reservation so the IP baked into the pairing QR does not drift.

Protocol smoke against real files:

```bash
node tools/make-fixtures.mjs D:\tmp\musictest
npm run server -- --music-dir D:\tmp\musictest
node tools/smoke.mjs http://localhost:5299 <token>
```

Omit the path to write a fresh temp dir. Fixtures are tagged MP3s plus an unsupported `.ogg`, a `.txt`, and a nested folder. Exit 0 with all `PASS` means the HTTP protocol works. `MUSIC_SYNC_URL` / `MUSIC_SYNC_TOKEN` are accepted instead of args.

## Build the app (Mac)

The Mac is for iOS builds and signing. Day-to-day TypeScript/UI work can run anywhere. Simulator is fine for UI; background downloads, background audio, BGTaskScheduler, and Lock Screen controls need a physical iPhone.

Requirements: **macOS 26.2+**, **Xcode 26.4+**, **Node 22.13+**, CocoaPods. Watchman is not needed on SDK 57.

### One-time Mac prep

1. Install **Xcode** from the Mac App Store (~10 GB). If that copy fails, download from https://developer.apple.com/xcode/. Launch it once, accept the license, install additional components.
2. Xcode → Settings → Locations → set Command Line Tools (or `xcode-select --install`). This also provides `git`.
3. Xcode → Settings → Components → install the iOS Simulator runtime.
4. Install Homebrew if needed, then Node and CocoaPods:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   brew install node cocoapods
   node --version   # must be >= 22.13
   ```

   Expo SDK 57 still uses CocoaPods; `npx expo run:ios` runs `pod install` but `pod` itself must exist.
5. Clone the repo and `npm install` at the **repo root**.

### Simulator (no signing)

```bash
cd app
npx expo prebuild -p ios --clean     # generates ios/ (not committed); --clean is explicit, SDK 57 cleans by default
npx expo run:ios                     # Debug Simulator + Metro; first compile 10–20 min
```

No `APP_VARIANT` → release-variant identity (`com.jiaqi.musicsync`) in a Debug build. Fine as a toolchain smoke test.

### First iPhone install (Release)

1. USB cable, unlock, tap **Trust**. Then Settings → Privacy & Security → **Developer Mode** on (the row appears only after a Mac with Xcode has talked to the phone) → restart → confirm.
2. Xcode → Settings → Accounts → add your free Apple ID. Team is "Your Name (Personal Team)".
3. `cd app && npx expo run:ios --device --configuration Release` (`--device` with no argument picks from a list). Release embeds the JS bundle; no Metro needed.
4. If signing fails ("requires a development team"), `open ios/MusicSync.xcworkspace`, select the MusicSync target → Signing & Capabilities → Automatically manage signing → Personal Team. Then put the team id in `app/.env.local` as `APPLE_TEAM_ID=<your team id>` (find it in Xcode → Settings → Accounts) so a later clean prebuild keeps the team. Close Xcode and rerun the CLI command.
5. On the phone: Settings → General → **VPN & Device Management** → Developer App → Trust. Then allow **Local Network** on first launch (or Settings → Privacy & Security → Local Network → MusicSync).
6. Run the [playback smoke](#iphone-playback-smoke) before treating the install as done.

**Free Apple ID:** the signing profile expires every **7 days**. The app bounces to the home screen until you rerun the Release install (same one-liner; synced music survives because the bundle id is unchanged). Settings shows build age (`extra.buildDate`) and warns after day 5. Caps: 10 new App IDs per rolling 7 days; 3 free-provisioned apps on the device. The $99/yr Apple Developer Program extends this to a year and unlocks EAS.

Weekly re-sign (iPhone plugged in, unlocked):

```bash
cd <repo> && git pull && npm install
cd app && npx expo run:ios --device --configuration Release
```

Device builds: `cd app` first. Never run `expo run:ios` from the repo root.

### Re-sign after the 7-day profile lapses

`expo run:ios` does not pass `-allowProvisioningUpdates`, so once the 7-day profile has lapsed it fails with `No profiles for 'com.jiaqi.musicsync'`. Mint a profile once from `app/ios/`, then install:

```bash
cd app/ios && xcodebuild -workspace MusicSync.xcworkspace -scheme MusicSync -configuration Release \
  -destination 'id=<UDID>' -allowProvisioningUpdates build
cd .. && npx expo run:ios --device <UDID> --configuration Release
```

After every re-sign the app installs but the launch step fails with `FBSOpenApplicationErrorDomain error 3` (invalid signature / profile not trusted). That is expected, not a build failure: confirm with `xcrun devicectl device info apps --device <UDID> | grep -i musicsync`, then on the phone Settings → General → VPN & Device Management → trust the Apple Development cert and launch from the home screen. `devicectl` launch can also fail with `CoreDeviceError 10002` when the phone is locked. List device ids with `xcrun xctrace list devices`; install fails if the phone is locked at connect time.

### Dev client (JS Fast Refresh)

```bash
cd app
APP_VARIANT=dev npx expo prebuild -p ios --clean
APP_VARIANT=dev npx expo run:ios --device
```

This overwrites `ios/` with the dev variant (a second App ID, also 7-day expiry). Metro can run on Windows: `npx expo start --dev-client --lan`. If the phone cannot see it, allow Node through the Windows firewall on **Private** networks (port 8081) and keep phone and PC on the same subnet. Rebuild the native client only when native deps or `app.config.ts` change — and weekly on the free account anyway. To ship Release again: prebuild **without** `APP_VARIANT`.

### Common failures

- **`pod install` fails** — `brew install cocoapods`; or delete `app/ios/` and prebuild `--clean`. After a `git pull` with mismatched Expo packages, from `app/` run `npx expo install --fix`.
- **"Failed to register bundle identifier"** — change the id in `app.config.ts`. New id = new app; library data does not carry over.
- **"Your maximum App ID limit has been reached"** — free accounts may create 10 App IDs per rolling 7 days. Wait it out; do not churn bundle-id suffixes.
- **"requires a development team" after a working setup** — clean prebuild dropped the team; `appleTeamId` should prevent this.
- **Launch bounces to home** — untrusted cert, or 7-day profile expired.
- **Cannot reach server** — Local Network permission; same Wi-Fi/subnet; Windows firewall on the server port (Private); Simulator uses the Mac's network.
- **Device not detected** — data-capable cable, unlocked, Trust, Developer Mode on. Check Xcode → Window → Devices and Simulators if it is stuck "preparing".

## Testing

```bash
npm test              # vitest across workspaces (shared schemas/diff, server HTTP/config/indexer/loudness/imports/overrides, app queue/playlists/layout/metadata/import clients)
npm run typecheck     # tsc across workspaces
```

CI (`.github/workflows/ci.yml`): `npm ci && npm run typecheck && npm test` on Node 24.

Import tests use fake downloader processes/injected runners and temporary libraries, never real YouTube downloads. They must cover URL validation, library isolation, durable acceptance/restart, duplicate requests, failed/partial downloads, and phone request identity/schema handling. A real-toolchain offline smoke can feed yt-dlp saved metadata for generated audio via a test-only wrapper: verify native M4A passthrough, Opus fallback conversion, literal edited tags, embedded cover, library isolation, and durable restart. File URLs/saved metadata are never enabled by the production importer. Live acceptance requires installed server tools and an authorized public YouTube link: preview/edit tags → add → desktop manifest → local offline playback; close/reopen the phone during import and verify no duplicate on retry.

### Maestro (simulator UI)

Drives accessibility text, not coordinates. Use a **Release** simulator build — the expo-dev-client launcher makes flows flaky.

```bash
cd app && npx expo run:ios --configuration Release --device "iPhone 17"
scripts/test-maestro-ios.sh
scripts/test-maestro-ios.sh --device "iPhone 17" --flow .maestro/smoke-mini-player.yaml
```

One-time: Maestro CLI v2.8+ via `curl -fsSL "https://get.maestro.mobile.dev" | bash` (installs to `~/.maestro/bin`; not the Homebrew cask named `maestro`), and Java 17+ (`brew install openjdk`, keg-only at `/opt/homebrew/opt/openjdk`). The runner finds Java, Maestro, and a booted simulator, and passes a unique `NAME` so create-playlist cannot false-pass on a leftover row. Without the runner: export `JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home`, put `$JAVA_HOME/bin` and `~/.maestro/bin` on `PATH`, then `maestro test -e NAME="<unique>" .maestro/create-playlist.yaml`.

Flows:

- `.maestro/smoke-mini-player.yaml` — Songs → play → mini-player pause/play → skip → open full player (`Close player`).
- `.maestro/create-playlist.yaml` — Playlists → New Playlist → Empty playlist → asserts the row; also the Alert.prompt refresh regression.

Accessibility conventions:

- Mini-player bar: `"Now playing <title> by <artist>"`; buttons `"Pause"` / `"Play"` and `"Next song"`.
- Full player dismiss: `"Close player"`.
- Song rows have no explicit label; Maestro sees concatenated `"<title>, <artist>, <badge>, <duration>"`. Match with a regex (`"Long Tone.*"`), never an exact title.
- Playlist rows concatenate to `"<name>, N songs · M min, ›"` (or `hr`). Match `"<name>.*"`, never an exact name.
- Tabs expose `"<Name>, tab, <n> of 4"` (e.g. `"Playlists, tab, 2 of 4"`); library segments are `"Artists"` / `"Albums"` / `"Songs"`.
- Assert absence before create (`assertNotVisible: "${NAME}.*"`).
- `maestro hierarchy` dumps the tree when a flow stalls.

### Song tools acceptance

- Copy a song A → B, repeat the copy, and verify it remains in A and appears once in B; Remove still removes only playlist membership.
- Offline: edit title/artist, reopen the app, and verify library search/grouping, playlists, and the current player show the edit. Reconnect and Sync Now: pending count clears and the desktop manifest/another paired phone receive the edit, with no audio download.
- Edit again while the first upload is in flight; the newer edit must remain pending. Restart the desktop after an accepted edit and confirm its manifest still contains it. Replace the desktop file before upload and verify the conflict is visible rather than silently relabeling the replacement.
- iPhone SE 3 (375×667): open the full player with a two-line title, verify the entire previous/play/next controls and seek bar are visible and tappable; repeat with large text. In Edit Song, open the keyboard and verify Save remains reachable.

### iPhone playback smoke

Run after the first Release install and after upgrading React Native or `react-native-track-player`. Simulator cannot validate background audio or Control Center.

Pair, sync at least two tracks, keep one stream-only if possible, watch the device console.

- [ ] Synced track starts; mini-player shows metadata.
- [ ] Pause / resume from mini-player.
- [ ] Seek, next, previous from full player; queue and metadata follow.
- [ ] Stream-only track plays over authenticated LAN.
- [ ] Lock the phone; audio continues.
- [ ] Lock Screen artwork/title; pause, play, next, previous, seek — each command once.
- [ ] Control Center pause/play and next/previous.
- [ ] Leave the app ≥ 1 minute; playback continues; return shows the right track/state/position.
- [ ] Interruption pauses; resumes only when iOS marks it resumable.
- [ ] Force-quit after pause; relaunch does not crash while the service registers.

Expected: a development-only warning that `RNTrackPlayer` uses the TurboModule interop layer. Failures: record build, iOS version, step, and console excerpt. Distinguish import-time registration failure from a playback/remote-event failure after `setupPlayer`.

## Decisions

**Keep `react-native-track-player` 4.1.2 on iOS / RN 0.86.** It is a legacy NativeModule. RN 0.86's interop layer loads it; unused sleep-timer exports are omitted rather than crashing. MusicSync does not call them.

**Level volume at playback, do not rewrite audio.** The LocalMusic pipeline this replaces re-encoded every file with ffmpeg `loudnorm` because its players were third-party. Here the player is ours, so the server only *measures* (ReplayGain-style) and the phone applies the gain. Files stay byte-identical: no generation loss on lossy rips, lossless stays lossless, track ids and content keys do not move, and enabling leveling on an existing library costs one manifest refresh instead of re-downloading everything. The trade is that a volume control cannot boost, hence the 4 dB headroom. Revisit `HEADROOM_DB` if a player API with a pre-amp appears or the library drifts much quieter than -18 LUFS (re-survey with `ffmpeg -af ebur128`).

Do not infer an iOS failure from the Android `kotlinx.coroutines.Job` registration bug. This product is iPhone-only.

Do not migrate to `@rntp/player` v5 without a failing iOS runtime observation: it is not a drop-in, and the license is not a standard open-source grant.

Revisit before RN/Expo upgrades, before Android support, if import-time registration fails on a physical iPhone, or when React Native announces interop-layer removal. After any RN or track-player upgrade, run the [playback smoke](#iphone-playback-smoke).

## Library hygiene

For desktop library cleanup, fill tags **in the files** and leave filenames unchanged. Phone **Edit Song** is intentionally different: it changes MusicSync's sidecar metadata only (see [Song metadata edits](#song-metadata-edits)).

Track identity is the SHA-1 of the relative path. A rename is a new id plus a deletion of the old one. Tag-only edits keep the id and change the content key, so the phone re-downloads once and still stores one copy.

Write the atoms the indexer already reads: MP4 `©ART` / `©nam` for `.m4a`, ID3 `TPE1` / `TIT2` for `.mp3`. Infer artist from `Artist - Title` filenames; skip ambiguous bare titles. Strip video junk from titles (`Official Video`, `Lyric Video`); keep remaster notes.

Apply when a library indexes as all `Unknown Artist`, or before the first phone sync so it downloads once.

## Lessons

**Alert.prompt refresh is device-only.** On a physical iPhone (iOS 18), a React state update whose paint lands during Alert.prompt keyboard teardown can be swallowed. The iOS Simulator never shows this. Maestro green on sim is not proof. Fix: refresh immediately and again at 400ms (`refreshAfterPrompt` in `app/app/(tabs)/playlists.tsx`). Do not reach for `InteractionManager.runAfterInteractions`. Assert list rows with a regex/prefix plus an absence precheck — concatenated a11y text is not the string you typed. Diagnose UI bugs with two probes (what the screen shows + a direct SQLite read).

**Shared checkout.** Announce before switching branches, or use a git worktree. A mid-build branch switch ships stale code to the phone. Feature work goes in a worktree: `git worktree add .worktrees/<name> -b <branch> main` (`.worktrees/` is excluded via `.git/info/exclude`). Do **not** symlink root `node_modules` wholesale — npm workspace links would resolve `@music-sync/shared` into main's packages and the worktree's schema changes become invisible to tsc. Instead create `node_modules/` in the worktree, symlink every entry of main's `node_modules/*` and `.bin` into it, point `node_modules/@music-sync/{shared,server,app}` at `../../<pkg>`, and symlink `app/`, `server/`, `shared/` `node_modules` dirs directly. Then `npx vitest run --root <pkg>` / `npm run typecheck --workspace <pkg>` from the worktree root. Device builds from a worktree: `npx expo run:ios` from `<worktree>/app`, optionally `-derivedDataPath build` under `app/ios`.

**Wrong cwd.** `expo run:ios` from repo root (not `app/`) generates a junk Expo project at root. Always `cd app` first.

## Not in product

- Android.
- Playlist sync to the desktop. Playlists are phone-local.
- Reorder-by-drag inside a playlist (schema has `position`; UI does not).
- Album-aware leveling (one shared gain per album, as LocalMusic did). Leveling is per track; the libraries are single rips without album tags.
- Cloud builds / EAS on the free Apple ID.
- Public internet access to the server (LAN guard is load-bearing).
