import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig, TrackRow } from '../src/db/queries';

type PlayerTrack = { id: string; url: string };

const trackPlayer = vi.hoisted(() => {
  let queue: PlayerTrack[] = [];
  let active: number | undefined;

  const api = {
    add: vi.fn(async (tracks: PlayerTrack[]) => {
      queue = queue.concat(tracks);
      if (active === undefined && queue.length > 0) active = 0;
    }),
    play: vi.fn(async () => undefined),
    reset: vi.fn(async () => {
      queue = [];
      active = undefined;
    }),
    skip: vi.fn(async (index: number) => {
      active = index;
    }),
    updateOptions: vi.fn(async () => undefined),
    updateMetadataForTrack: vi.fn(async (index: number, metadata: { title?: string; artist?: string }) => {
      queue[index] = { ...queue[index]!, ...metadata };
    }),
    setVolume: vi.fn(async () => undefined),
    getActiveTrack: vi.fn(async () => (active === undefined ? undefined : queue[active])),
    getActiveTrackIndex: vi.fn(async () => active),
    getQueue: vi.fn(async () => queue),
    remove: vi.fn(async (indexes: number[]) => {
      const drop = new Set(indexes);
      const current = active === undefined ? undefined : queue[active];
      queue = queue.filter((_, i) => !drop.has(i));
      if (current === undefined) {
        active = queue.length > 0 ? 0 : undefined;
        return;
      }
      const next = queue.findIndex((track) => track.id === current.id);
      active = next >= 0 ? next : queue.length > 0 ? 0 : undefined;
    }),
    removeUpcomingTracks: vi.fn(async () => {
      if (active === undefined) {
        queue = [];
        return;
      }
      queue = queue.slice(0, active + 1);
    }),
    _state: () => ({ queue: [...queue], active }),
  };
  return api;
});

const paths = vi.hoisted(() => ({
  localArtworkUri: vi.fn(() => null),
  resolveLocalUri: vi.fn((row: { id: string }): string | null => `file:///current/${row.id}.mp3`),
}));

vi.mock('react-native-track-player', () => ({
  default: trackPlayer,
  Capability: { Play: 'play', Pause: 'pause', SkipToNext: 'next', SkipToPrevious: 'previous', SeekTo: 'seek' },
  IOSCategory: { Playback: 'playback' },
}));
vi.mock('../src/api/client', () => ({
  authHeaders: vi.fn(() => ({})),
  trackUrl: vi.fn((_cfg: unknown, id: string) => `http://server/tracks/${id}`),
}));
const database = vi.hoisted(() => ({ byId: vi.fn((): Partial<TrackRow> | null => null) }));
vi.mock('../src/db/queries', () => ({
  byId: database.byId,
  getServerConfig: vi.fn(() => null),
  getVolumeLeveling: vi.fn(() => true),
  setVolumeLeveling: vi.fn(),
}));
vi.mock('../src/sync/paths', () => paths);

import { levelingVolume } from '../src/player/loudness';
import { clearQueue, playContext, refreshQueueMetadata, toPlayerTrack, toggleShuffle } from '../src/player/queue';
import { setVolumeLeveling } from '../src/player/volume';
import { usePlayerStore } from '../src/store/playerStore';

function track(id: string, loudness: number | null = null): TrackRow {
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
    loudness,
    truePeak: null,
    state: 'synced',
    localUri: `file:///${id}.mp3`,
    errorCount: 0,
    updatedAt: 0,
  };
}

function addedIds(): string[] {
  const last = trackPlayer.add.mock.calls.at(-1)?.[0] as Array<{ id: string }> | undefined;
  return last?.map((item) => item.id) ?? [];
}

describe('playContext', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    usePlayerStore.setState({ shuffle: false });
    await trackPlayer.reset();
  });

  it('re-asserts remote-control capabilities after loading the queue', async () => {
    await playContext([track('first')], 0);

    expect(trackPlayer.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: expect.arrayContaining(['play', 'next']) }),
    );
    expect(trackPlayer.play.mock.invocationCallOrder[0]).toBeLessThan(
      trackPlayer.updateOptions.mock.invocationCallOrder[0]!,
    );
  });

  it('levels the starting track before play, using its loudness', async () => {
    usePlayerStore.setState({ leveling: true });
    await playContext([track('quiet', -20), track('loud', -6)], 1);

    expect(trackPlayer.setVolume).toHaveBeenCalledOnce();
    expect(trackPlayer.setVolume).toHaveBeenCalledWith(levelingVolume(-6, true));
    expect(trackPlayer.setVolume.mock.invocationCallOrder[0]).toBeLessThan(
      trackPlayer.play.mock.invocationCallOrder[0]!,
    );
  });

  it('plays at unity when leveling is off, and re-levels the active track on toggle', async () => {
    usePlayerStore.setState({ leveling: false });
    await playContext([track('loud', -6)], 0);
    expect(trackPlayer.setVolume).toHaveBeenLastCalledWith(1);

    await setVolumeLeveling(true);
    expect(usePlayerStore.getState().leveling).toBe(true);
    expect(trackPlayer.setVolume).toHaveBeenLastCalledWith(levelingVolume(-6, true));
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

  it('turns shuffle on, randomizes the list, and starts at the first shuffled item', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    await playContext([track('a'), track('b'), track('c')], 2, { shuffle: true });

    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(trackPlayer.skip).not.toHaveBeenCalled();
    expect(new Set(addedIds())).toEqual(new Set(['a', 'b', 'c']));
    expect(addedIds()).not.toEqual(['a', 'b', 'c']);
    random.mockRestore();
  });

  it('keeps the tapped track first when shuffle is already on', async () => {
    usePlayerStore.setState({ shuffle: true });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    await playContext([track('a'), track('b'), track('c')], 1);

    expect(addedIds()[0]).toBe('b');
    expect(new Set(addedIds())).toEqual(new Set(['a', 'b', 'c']));
    expect(trackPlayer.skip).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('turns shuffle off and plays in the given order', async () => {
    usePlayerStore.setState({ shuffle: true });

    await playContext([track('a'), track('b'), track('c')], 1, { shuffle: false });

    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(addedIds()).toEqual(['a', 'b', 'c']);
    expect(trackPlayer.skip).toHaveBeenCalledWith(1);
  });
});

describe('toggleShuffle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    usePlayerStore.setState({ shuffle: false });
    await trackPlayer.reset();
  });

  it('turns on around the current track, including already-played songs', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    await playContext([track('a'), track('b'), track('c')], 1);
    trackPlayer.add.mockClear();
    trackPlayer.remove.mockClear();
    trackPlayer.removeUpcomingTracks.mockClear();

    await toggleShuffle();

    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(trackPlayer.remove).toHaveBeenCalledWith([0]);
    expect(trackPlayer.removeUpcomingTracks).toHaveBeenCalledOnce();
    expect(new Set(addedIds())).toEqual(new Set(['a', 'c']));
    expect(trackPlayer._state().queue.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(trackPlayer._state().active).toBe(0);
    random.mockRestore();
  });

  it('still reshuffles when the current track is the last in the queue', async () => {
    await playContext([track('a'), track('b'), track('c')], 2);
    trackPlayer.add.mockClear();

    await toggleShuffle();

    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(new Set(addedIds())).toEqual(new Set(['a', 'b']));
    expect(trackPlayer._state().queue[0]?.id).toBe('c');
    expect(trackPlayer._state().queue).toHaveLength(3);
  });

  it('restores the leftover original order when turning off', async () => {
    await playContext([track('a'), track('b'), track('c')], 1);
    await toggleShuffle();
    trackPlayer.add.mockClear();
    trackPlayer.remove.mockClear();

    await toggleShuffle();

    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(addedIds()).toEqual(['c']);
    expect(trackPlayer._state().queue.map((item) => item.id)).toEqual(['b', 'c']);
    expect(trackPlayer._state().active).toBe(0);
  });

  it('updates the flag even when nothing is playing yet', async () => {
    await toggleShuffle();

    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(trackPlayer.removeUpcomingTracks).not.toHaveBeenCalled();
  });
});

describe('clearQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    usePlayerStore.setState({ shuffle: false });
    await trackPlayer.reset();
  });

  it('empties the native queue and turns shuffle off', async () => {
    await playContext([track('a'), track('b')], 0, { shuffle: true });

    await clearQueue();

    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(trackPlayer.reset).toHaveBeenCalled();
  });

  it('marks the player dismissed until the next playContext', async () => {
    await playContext([track('a')], 0);
    await clearQueue();
    expect(usePlayerStore.getState().dismissed).toBe(true);

    // The mini player hides on this flag, not on useActiveTrack, which never
    // reports "no track" when a new context immediately replaces the queue.
    await playContext([track('b')], 0);
    expect(usePlayerStore.getState().dismissed).toBe(false);
  });

  it('drops the saved context so a later shuffle-off has nothing stale to restore', async () => {
    await playContext([track('a'), track('b'), track('c')], 0);
    await clearQueue();

    await playContext([track('x'), track('y')], 0);
    await toggleShuffle(); // on
    await toggleShuffle(); // off — must restore from the new context only

    expect(addedIds().every((id) => ['x', 'y'].includes(id))).toBe(true);
  });
});

describe('refreshQueueMetadata', () => {
  it('updates active/upcoming labels and shuffle context without interrupting playback', async () => {
    usePlayerStore.setState({ shuffle: false });
    await playContext([track('a'), track('b')], 0);
    trackPlayer.reset.mockClear();
    trackPlayer.play.mockClear();
    database.byId.mockImplementation((...args: unknown[]) => ({ id: args[0] as string, title: 'New title', artist: 'New artist' }));
    await refreshQueueMetadata();
    expect(trackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(0, { title: 'New title', artist: 'New artist' });
    expect(trackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(1, { title: 'New title', artist: 'New artist' });
    expect(trackPlayer.reset).not.toHaveBeenCalled();
    expect(trackPlayer.play).not.toHaveBeenCalled();
    await toggleShuffle();
    await toggleShuffle();
    expect(trackPlayer._state().queue[1]).toMatchObject({ id: 'b', title: 'New title', artist: 'New artist' });
    database.byId.mockReturnValue(null);
  });
});

describe('toPlayerTrack', () => {
  const cfg = { host: 'server', port: 5299, token: 't' } as ServerConfig;

  it('plays from the re-resolved local uri, not the stale db value', () => {
    // iOS moves the app container on reinstall; the db's localUri is stale.
    expect(toPlayerTrack(track('a'), cfg).url).toBe('file:///current/a.mp3');
  });

  it('falls back to streaming when the local file is missing on disk', () => {
    paths.resolveLocalUri.mockReturnValueOnce(null);
    const mapped = toPlayerTrack(track('a'), cfg);
    expect(mapped.url).toBe('http://server/tracks/a');
    expect(mapped.headers).toBeDefined();
  });
});
