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

The iPhone app includes local-only playlists in the **Playlists** tab. Create, rename, or delete a playlist, search your synced library to add multiple songs, remove songs, and play or shuffle the playlist using the same offline-first player as the main library. Playlist data is stored on the phone and is not sent to the desktop server.

Playlists keep their records when the local library is wiped, but their song entries are removed with the corresponding local track rows; sync can repopulate the library afterward.

## Development

```bash
npm test              # vitest: shared diff suite + server suite
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
