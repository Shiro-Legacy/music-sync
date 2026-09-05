import { create } from 'zustand';

/**
 * Playback UI flags. Queue mutations live in `src/player/queue.ts`; this store
 * only publishes state the player chrome needs to re-render.
 */
export const usePlayerStore = create<{ shuffle: boolean; dismissed: boolean; leveling: boolean }>()(
  () => ({
    shuffle: false,
    /** True after the mini player is swiped away, until the next playContext. */
    dismissed: false,
    /** Volume leveling (per-track gain from server-measured loudness). Loaded from kv at startup. */
    leveling: true,
  }),
);
