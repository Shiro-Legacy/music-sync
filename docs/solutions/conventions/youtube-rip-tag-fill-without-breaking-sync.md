---
title: Fill YouTube-rip tags without changing track identity
date: 2026-08-14
category: conventions
module: library-metadata
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Library files were ripped from YouTube and have no artist or title tags"
  - "The indexer falls back to Unknown Artist and the filename stem"
  - "Tag writes must not rename files or the track id will change"
tags:
  - metadata
  - mutagen
  - artist-tag
  - title-tag
  - content-key
  - track-id
  - youtube-rip
---

# Fill YouTube-rip tags without changing track identity

## Context

A 261-track test library was imported from YouTube rips (almost all `.m4a`, one `.mp3`). Embedded tags held only the encoder string; there was no artist or title atom. The server indexer therefore published every track as `Unknown Artist` with the filename stem as the title, so the phone library could not browse by artist and song names were YouTube upload titles (`Avicii - Hey Brother`, `…(Official Video)`).

This is a library-hygiene convention, not a product-code bug. The indexer already reads tags correctly; the files had nothing to read.

## Guidance

Fill tags **in the files**. Leave filenames unchanged.

1. Infer artist from the filename when it is `Artist - Title`, an MV/lyric-video pattern, or an anime/game opening that names the song. For bare titles, match duration against iTunes Search (or equivalent) and keep only exact or near-exact length hits. Skip a track when several well-known songs share the title and none match duration.
2. Write the artist atom the indexer already understands: MP4 `©ART` for `.m4a`, ID3 `TPE1` for `.mp3`. Do not invent album or year unless you have them.
3. Optionally write a cleaned title to MP4 `©nam` / ID3 `TIT2`: strip the artist prefix and video/lyrics junk (`Official Video`, `Lyric Video`, `M/V`, `歌词版`). Keep remaster notes (`Remastered 2011`) and featured-artist suffixes that are part of the song name.
4. Do **not** rename the file. Track identity is the SHA-1 of the relative path. A rename is a new id plus a deletion of the old one.
5. Expect the phone to re-download every retagged file. Content identity hashes the first and last 64 KB plus the byte size, so tag bytes change that hash. A same-id / different-content-key pair is a re-download. End storage is still one copy per track.
6. A live server reindexes when size or mtime changes. That is intended. Do not stop it to "protect" the phone.

Verified this session: 259/261 artists written; `Answer.m4a` and `Listen.m4a` skipped (no duration match). 117 titles cleaned; 144 already were just the song name. Filenames left intact.

## Why This Matters

- Without an artist tag the indexer hard-codes `Unknown Artist` and the app cannot group the library.
- Without a title tag the indexer uses the filename stem, which for this corpus is a YouTube upload name.
- Renaming to "fix" the display name would rotate every track id and look like a mass delete plus add on the phone.
- Tag-only edits are the opposite: stable ids, changed content keys, a one-time re-sync. (session history: a prior session confirmed the phone replaces the file for that id rather than keeping two copies.)

## When to Apply

- A library (or a newly dropped folder) indexes as all `Unknown Artist`.
- Filenames carry artist or `(Official Video)` / lyric-video junk that should not be the displayed title.
- You are about to let a paired phone sync and would rather retag first, so it downloads once.

## Examples

Before (no tags; indexer fallback):

- path `Avicii - Hey Brother.m4a` → artist `Unknown Artist`, title `Avicii - Hey Brother`
- path `Numb (Official Music Video) [4K UPGRADE] – Linkin Park.m4a` → artist `Unknown Artist`, title the full stem

After (tags written, filename unchanged):

- same path → artist `Avicii`, title `Hey Brother`
- same path → artist `Linkin Park`, title `Numb`

Mutagen write shape used this session:

- `.m4a`: `audio["\xa9ART"] = [artist]`; `audio["\xa9nam"] = [title]`
- `.mp3`: ID3 `TPE1` / `TIT2`

Run logs (untracked scratch, not product): `.quad/shared/artist-fill-results.json`, `.quad/shared/title-clean-results.json`.

## Related

- No prior `docs/solutions/` entries. GitHub issue search was skipped (unauthenticated `gh`).
