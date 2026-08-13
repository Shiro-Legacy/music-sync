import type { TrackEntry } from './manifest.js';

export type LocalTrackState = 'queued' | 'downloading' | 'synced' | 'failed';

/** The app's local view of a track (a row in its SQLite tracks table). */
export interface LocalTrack {
  id: string;
  contentKey: string;
  state: LocalTrackState;
}

/** Rename rescue: the local file stored under fromId is the same bytes as manifest track toId — move it instead of re-downloading. */
export interface MoveOp {
  fromId: string;
  toId: string;
}

export interface SyncPlan {
  /** Manifest track ids that need a (re-)download. Includes brand-new tracks, content changes, and never-completed downloads. */
  toDownload: string[];
  /** Local files to rename instead of re-downloading (desktop-side file moves/renames). */
  toMove: MoveOp[];
  /** Local track ids to remove (file + row). */
  toDelete: string[];
  /**
   * Mass-deletion safety valve: true when the plan would delete more than 25% of a >100-track
   * local library. The caller must hold toDelete until the user confirms, but may still apply
   * downloads and moves.
   */
  deletionsHeld: boolean;
}

const MASS_DELETE_MIN_LIBRARY = 100;
const MASS_DELETE_FRACTION = 0.25;

/**
 * Pure diff between the server manifest and the local library.
 *
 * Callers must pass manifest tracks already filtered to playable formats (format !== 'unsupported'),
 * and must only apply the plan when the manifest fully parsed and its serverId matches the paired
 * server — those guards live in the sync engine, not here.
 */
export function computeSyncPlan(
  manifestTracks: readonly TrackEntry[],
  localTracks: readonly LocalTrack[],
): SyncPlan {
  const localById = new Map<string, LocalTrack>();
  for (const t of localTracks) localById.set(t.id, t);

  const manifestIds = new Set<string>();
  const additions: TrackEntry[] = [];
  const toDownload: string[] = [];

  for (const m of manifestTracks) {
    manifestIds.add(m.id);
    const local = localById.get(m.id);
    if (!local) {
      additions.push(m); // may become a move via rename rescue below
    } else if (local.contentKey !== m.contentKey) {
      toDownload.push(m.id); // content changed on the desktop (re-encode, tag edit, replacement)
    } else if (local.state !== 'synced') {
      toDownload.push(m.id); // known but never finished downloading — re-enqueue (idempotent)
    }
  }

  // Local tracks the manifest no longer mentions: deletion candidates, and the pool for rename rescue.
  const deletionCandidates: LocalTrack[] = [];
  for (const l of localTracks) {
    if (!manifestIds.has(l.id)) deletionCandidates.push(l);
  }

  // Rename rescue: only fully-synced local files actually exist on disk to be moved.
  const rescuePool = new Map<string, LocalTrack[]>();
  for (const l of deletionCandidates) {
    if (l.state !== 'synced') continue;
    const pool = rescuePool.get(l.contentKey);
    if (pool) pool.push(l);
    else rescuePool.set(l.contentKey, [l]);
  }

  const toMove: MoveOp[] = [];
  const rescuedFromIds = new Set<string>();
  for (const added of additions) {
    const pool = rescuePool.get(added.contentKey);
    const candidate = pool?.pop();
    if (candidate) {
      toMove.push({ fromId: candidate.id, toId: added.id });
      rescuedFromIds.add(candidate.id);
    } else {
      toDownload.push(added.id);
    }
  }

  const toDelete = deletionCandidates.filter((l) => !rescuedFromIds.has(l.id)).map((l) => l.id);

  const deletionsHeld =
    localTracks.length > MASS_DELETE_MIN_LIBRARY &&
    toDelete.length > localTracks.length * MASS_DELETE_FRACTION;

  return { toDownload, toMove, toDelete, deletionsHeld };
}
