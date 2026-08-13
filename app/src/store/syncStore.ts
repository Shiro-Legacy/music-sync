import { create } from 'zustand';

export type SyncStatus = 'idle' | 'checking' | 'syncing' | 'error' | 'unpaired';

export interface SyncState {
  status: SyncStatus;
  /** Downloads finished (ok or permanently failed) since the current sync began. */
  done: number;
  /** Downloads outstanding when the current sync began. */
  total: number;
  /** Tracks that hit their retry limit during the current sync. */
  failed: number;
  error?: string;
}

/**
 * Live sync progress. Written by the sync engine (via setState), read by the UI.
 */
export const useSyncStore = create<SyncState>()(() => ({
  status: 'idle',
  done: 0,
  total: 0,
  failed: 0,
  error: undefined,
}));
