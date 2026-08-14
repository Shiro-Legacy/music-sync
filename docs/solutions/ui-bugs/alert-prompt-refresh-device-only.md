---
title: Alert.prompt refresh bug is device-only — the simulator cannot reproduce or verify it
date: 2026-08-14
category: ui-bugs
module: playlists
problem_type: timing-race
component: react-native-alert
severity: high
applies_when:
  - "A list/screen fails to update after an Alert.prompt (text input) callback on a physical device"
  - "The same flow works in the iOS Simulator"
  - "A Maestro/E2E assertion passes or fails in ways that contradict what the DB contains"
tags:
  - alert-prompt
  - keyboard-teardown
  - device-only
  - repaint
  - false-pass
  - maestro
---

# Alert.prompt refresh bug is device-only — the simulator cannot reproduce it

## Context

Creating or renaming a playlist (Playlists tab → Alert.prompt) wrote the row to
SQLite but the list did not update until the next tab focus — on the physical
iPhone (iOS 18) only. Three fixes shipped before the truth was established:

1. `InteractionManager.runAfterInteractions(refresh)` — a guess; didn't fix it.
2. A diagnosis "runAfterInteractions never fires" — WRONG; it was an artifact of
   a Maestro exact-match assertion (`"Maestro Test"` vs the row's real a11y text
   `"Maestro Test, 0 songs · 0 min, ›"`), a false NEGATIVE.
3. Corrected sim matrix: direct refresh, setTimeout(0), setTimeout(400), and
   runAfterInteractions ALL work in the simulator. The bug never existed there.

## Root cause (as best establishable)

On device, a React state update whose repaint lands while the Alert.prompt
keyboard/alert teardown is still animating can be swallowed. The iOS 18 device
teardown is slow enough to hit the window; the iOS 26 simulator is not.

## The fix that works (verified on device)

`app/app/(tabs)/playlists.tsx` — refresh twice: immediately AND after teardown:

```ts
const refreshAfterPrompt = useCallback(() => {
  refresh();
  setTimeout(refresh, 400);
}, [refresh]);
```

Re-reading a SQLite-backed list twice is idempotent and cheap; one of the two
always paints regardless of teardown timing.

## Lessons

- **Sim green ≠ device green** for anything involving native alert/keyboard
  timing. The only verification for this class of bug is the physical device.
- **Assert what the screen renders, not what you typed.** List rows expose
  concatenated a11y labels; use a regex/prefix match plus an absent-before
  precheck, or the flow false-passes/false-fails (both happened this session).
- **Diagnose with two independent probes** (UI assertion + direct sqlite3 read
  of the app DB). The DB probe is what exposed the false negative.

## When to Apply

- Any "UI doesn't update after Alert/prompt/modal dismissal, device-only" report.
- Writing Maestro assertions against FlashList/list rows.
- Tempted to wrap a refresh in InteractionManager to fix a paint issue — don't;
  prefer the idempotent double-refresh above.

## Related

- [[youtube-rip-tag-fill-without-breaking-sync]] (conventions) — unrelated
  domain, same repo hygiene doc set.
- `docs/maestro-testing.md` — the runner/flows this bug hardened
  (unique names, absence prechecks, screen markers).
