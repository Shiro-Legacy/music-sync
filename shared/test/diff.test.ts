import { describe, expect, it } from 'vitest';
import { computeSyncPlan, type LocalTrack, type LocalTrackState } from '../src/diff.js';
import type { TrackEntry } from '../src/manifest.js';

function mTrack(id: string, contentKey: string, overrides: Partial<TrackEntry> = {}): TrackEntry {
  return {
    id,
    path: `music/${id}.mp3`,
    size: 1000,
    mtimeMs: 1,
    contentKey,
    format: 'mp3',
    title: id,
    artist: 'artist',
    album: 'album',
    durationSec: 60,
    ...overrides,
  };
}

function lTrack(id: string, contentKey: string, state: LocalTrackState = 'synced'): LocalTrack {
  return { id, contentKey, state };
}

describe('computeSyncPlan', () => {
  it('returns an empty plan when both sides are empty', () => {
    expect(computeSyncPlan([], [])).toEqual({
      toDownload: [],
      toMove: [],
      toDelete: [],
      deletionsHeld: false,
    });
  });

  it('queues brand-new manifest tracks for download', () => {
    const plan = computeSyncPlan([mTrack('a', 'k1'), mTrack('b', 'k2')], []);
    expect(plan.toDownload.sort()).toEqual(['a', 'b']);
    expect(plan.toMove).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it('does nothing for synced tracks with matching contentKey', () => {
    const plan = computeSyncPlan([mTrack('a', 'k1')], [lTrack('a', 'k1', 'synced')]);
    expect(plan).toEqual({ toDownload: [], toMove: [], toDelete: [], deletionsHeld: false });
  });

  it('re-downloads when contentKey changed (file re-tagged or replaced on desktop)', () => {
    const plan = computeSyncPlan([mTrack('a', 'k2')], [lTrack('a', 'k1', 'synced')]);
    expect(plan.toDownload).toEqual(['a']);
    expect(plan.toDelete).toEqual([]);
  });

  it.each<LocalTrackState>(['queued', 'downloading', 'failed'])(
    're-enqueues known-but-unfinished tracks in state %s',
    (state) => {
      const plan = computeSyncPlan([mTrack('a', 'k1')], [lTrack('a', 'k1', state)]);
      expect(plan.toDownload).toEqual(['a']);
    },
  );

  it('deletes local tracks the manifest no longer contains', () => {
    const plan = computeSyncPlan([mTrack('a', 'k1')], [lTrack('a', 'k1'), lTrack('gone', 'k9')]);
    expect(plan.toDelete).toEqual(['gone']);
    expect(plan.toDownload).toEqual([]);
  });

  it('rescues renames: same contentKey under a new id becomes a move, not a download+delete', () => {
    const plan = computeSyncPlan(
      [mTrack('new-id', 'k1')],
      [lTrack('old-id', 'k1', 'synced')],
    );
    expect(plan.toMove).toEqual([{ fromId: 'old-id', toId: 'new-id' }]);
    expect(plan.toDownload).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it('only rescues from fully-synced local files (a queued ghost cannot be moved)', () => {
    const plan = computeSyncPlan(
      [mTrack('new-id', 'k1')],
      [lTrack('old-id', 'k1', 'queued')],
    );
    expect(plan.toMove).toEqual([]);
    expect(plan.toDownload).toEqual(['new-id']);
    expect(plan.toDelete).toEqual(['old-id']);
  });

  it('matches rescue candidates one-to-one when contentKeys are duplicated', () => {
    // Desktop had two identical files; one was renamed, one deleted.
    const plan = computeSyncPlan(
      [mTrack('new-1', 'dup')],
      [lTrack('old-1', 'dup', 'synced'), lTrack('old-2', 'dup', 'synced')],
    );
    expect(plan.toMove).toHaveLength(1);
    expect(plan.toMove[0]!.toId).toBe('new-1');
    expect(plan.toDelete).toHaveLength(1);
    expect(plan.toDownload).toEqual([]);
    const movedFrom = plan.toMove[0]!.fromId;
    const deleted = plan.toDelete[0]!;
    expect(new Set([movedFrom, deleted])).toEqual(new Set(['old-1', 'old-2']));
  });

  it('downloads the surplus when more manifest duplicates exist than rescuable locals', () => {
    const plan = computeSyncPlan(
      [mTrack('new-1', 'dup'), mTrack('new-2', 'dup')],
      [lTrack('old-1', 'dup', 'synced')],
    );
    expect(plan.toMove).toHaveLength(1);
    expect(plan.toDownload).toHaveLength(1);
    expect(plan.toDelete).toEqual([]);
    expect(new Set([plan.toMove[0]!.toId, plan.toDownload[0]!])).toEqual(
      new Set(['new-1', 'new-2']),
    );
  });

  it('handles a full library reorganization as pure moves', () => {
    const manifest = Array.from({ length: 50 }, (_, i) => mTrack(`new-${i}`, `k${i}`));
    const local = Array.from({ length: 50 }, (_, i) => lTrack(`old-${i}`, `k${i}`, 'synced'));
    const plan = computeSyncPlan(manifest, local);
    expect(plan.toMove).toHaveLength(50);
    expect(plan.toDownload).toEqual([]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.deletionsHeld).toBe(false);
  });

  describe('mass-deletion safety valve', () => {
    const bigLocal = (n: number) => Array.from({ length: n }, (_, i) => lTrack(`t${i}`, `k${i}`));

    it('holds deletions when >25% of a >100-track library would be deleted', () => {
      const local = bigLocal(200);
      const manifest = local.slice(0, 140).map((l) => mTrack(l.id, l.contentKey)); // deletes 60/200 = 30%
      const plan = computeSyncPlan(manifest, local);
      expect(plan.toDelete).toHaveLength(60);
      expect(plan.deletionsHeld).toBe(true);
    });

    it('does not hold at exactly 25%', () => {
      const local = bigLocal(200);
      const manifest = local.slice(0, 150).map((l) => mTrack(l.id, l.contentKey)); // deletes 50/200 = 25%
      const plan = computeSyncPlan(manifest, local);
      expect(plan.toDelete).toHaveLength(50);
      expect(plan.deletionsHeld).toBe(false);
    });

    it('never holds for small libraries (≤100 tracks), even a full wipe', () => {
      const local = bigLocal(100);
      const plan = computeSyncPlan([], local);
      expect(plan.toDelete).toHaveLength(100);
      expect(plan.deletionsHeld).toBe(false);
    });

    it('holds on an empty manifest against a big library (server misconfiguration guard)', () => {
      const local = bigLocal(101);
      const plan = computeSyncPlan([], local);
      expect(plan.toDelete).toHaveLength(101);
      expect(plan.deletionsHeld).toBe(true);
    });

    it('rescued moves do not count as deletions for the valve', () => {
      const local = Array.from({ length: 200 }, (_, i) => lTrack(`old-${i}`, `k${i}`, 'synced'));
      const manifest = local.map((l) => mTrack(`new-${l.id}`, l.contentKey));
      const plan = computeSyncPlan(manifest, local);
      expect(plan.toMove).toHaveLength(200);
      expect(plan.toDelete).toEqual([]);
      expect(plan.deletionsHeld).toBe(false);
    });
  });
});
