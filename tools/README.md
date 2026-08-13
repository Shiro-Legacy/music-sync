# Smoke kit

1. `node tools/make-fixtures.mjs D:\tmp\musictest` — generate a throwaway music library (valid tagged MP3s + .ogg + .txt + nested MP3); omit the path to use a fresh temp dir.
2. `npm run server -- --music-dir D:\tmp\musictest` — start the server against that library, note the token it prints.
3. `node tools/smoke.mjs http://localhost:5299 <token>` — run the end-to-end protocol checks (or set `MUSIC_SYNC_URL` / `MUSIC_SYNC_TOKEN`).
4. Exit code 0 with all `PASS` lines means the HTTP protocol works against real files; any `FAIL` exits non-zero.
