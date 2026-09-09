# Agent notes

**Two documents.** [`README.md`](README.md) is the **static product doc** — what MusicSync is and how to build, run, and test it. It contains no personal information (the repo is public): no device details, library contents, signing identity, or deployment state. `DEPLOYMENT.md` (**gitignored**, local to this machine) holds the mutable state: current deployment, phones, libraries, backlog, and where the Apple team id lives (`app/.env.local`).

- When you change behavior, protocol, CLI, schema, playback, sync, playlists, build, or tests, update the matching README section in the same change. When deployment state changes, update `DEPLOYMENT.md`. Do not add other markdown files, and never put personal/device/signing details in tracked files.
- `.quad/` is gitignored session scratch. Do not treat it as current product docs.
- Expo has changed. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing app code.
- Run `expo` commands from `app/`, never the repo root. Announce before switching branches in the shared checkout, or use a worktree (README → Current deployment).
