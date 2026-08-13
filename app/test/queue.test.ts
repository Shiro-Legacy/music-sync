import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrackRow } from '../src/db/queries';

const trackPlayer = vi.hoisted(() => ({
  add: vi.fn<(tracks: unknown[]) => Promise<void>>(),
  play: vi.fn<() => Promise<void>>(),
  reset: vi.fn<() => Promise<void>>(),
  skip: vi.fn<(index: number) => Promise<void>>(),
}));

vi.mock('react-native-track-player', () => ({ default: trackPlayer }));
vi.mock('../src/api/client', () => ({
  authHeaders: vi.fn(() => ({})),
  trackUrl: vi.fn(() => ''),
}));
vi.mock('../src/db/queries', () => ({ getServerConfig: vi.fn(() => null) }));
vi.mock('../src/sync/paths', () => ({ localArtworkUri: vi.fn(() => null) }));

import { playContext } from '../src/player/queue';

function track(id: string): TrackRow {
  return {
    id,
    path: `${id}.mp3`,
    contentKey: id,
    format: 'mp3',
    title: id,
    artist: 'Artist',
    albumArtist: null,
    album: 'Album',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    durationSec: 60,
    size: 1,
    artworkId: null,
    state: 'synced',
    localUri: `file:///${id}.mp3`,
    errorCount: 0,
    updatedAt: 0,
  };
}

describe('playContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackPlayer.reset.mockResolvedValue(undefined);
    trackPlayer.add.mockResolvedValue(undefined);
    trackPlayer.skip.mockResolvedValue(undefined);
    trackPlayer.play.mockResolvedValue(undefined);
  });

  it('plays the first track without redundantly skipping to index zero', async () => {
    await playContext([track('first'), track('second')], 0);

    expect(trackPlayer.skip).not.toHaveBeenCalled();
    expect(trackPlayer.play).toHaveBeenCalledOnce();
  });

  it('skips to a nonzero requested track before playing', async () => {
    await playContext([track('first'), track('second')], 1);

    expect(trackPlayer.skip).toHaveBeenCalledOnce();
    expect(trackPlayer.skip).toHaveBeenCalledWith(1);
    expect(trackPlayer.skip.mock.invocationCallOrder[0]).toBeLessThan(
      trackPlayer.play.mock.invocationCallOrder[0]!,
    );
  });
});
