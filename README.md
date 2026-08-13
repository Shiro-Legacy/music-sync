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
