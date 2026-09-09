# Agent notes

**Single source of truth:** [`README.md`](README.md). It is the only markdown document in this repo; everything needed to continue work is there, including the current deployment state.

- When you change behavior, protocol, CLI, schema, playback, sync, playlists, build, tests, or deployment state, update the matching README section in the same change. Do not add new markdown files.
- `.quad/` is gitignored session scratch. Do not treat it as current product docs.
- Expo has changed. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing app code.
- Run `expo` commands from `app/`, never the repo root. Announce before switching branches in the shared checkout, or use a worktree (README → Current deployment).
