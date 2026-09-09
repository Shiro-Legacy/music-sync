import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  cfg: { host: 'desktop', port: 5300, token: 'secret', serverId: 'library-a', name: 'Desktop' },
  pairedId: 'library-a',
  edits: [{ trackId: 'song-1', serverId: 'library-a', contentKey: 'bytes-1', title: 'Edited', artist: 'Artist', generation: 1 }],
  ack: vi.fn(),
}));
vi.mock('../src/db/queries', () => ({
  getServerConfig: () => ({ ...state.cfg, serverId: state.pairedId }),
  listPendingMetadata: (id: string) => state.edits.filter((edit) => edit.serverId === id),
  acknowledgeMetadata: state.ack,
}));

import { pushPendingMetadata } from '../src/sync/metadata';

const accepted = () => ({ serverId: 'library-a', id: 'song-1', title: 'Edited', artist: 'Artist' });
let fetchMock = vi.fn();
beforeEach(() => {
  state.pairedId = 'library-a';
  state.edits = [{ trackId: 'song-1', serverId: 'library-a', contentKey: 'bytes-1', title: 'Edited', artist: 'Artist', generation: 1 }];
  state.ack.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('sends authenticated byte-guarded edits and acknowledges only a matching response', async () => {
  fetchMock.mockResolvedValue(Response.json(accepted()));
  expect(await pushPendingMetadata(state.cfg)).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith('http://desktop:5300/api/v1/tracks/song-1/metadata', expect.objectContaining({
    method: 'PATCH',
    headers: expect.objectContaining({ Authorization: 'Bearer secret', 'X-MusicSync-Server-Id': 'library-a', 'If-Match': '"bytes-1"' }),
    body: JSON.stringify({ title: 'Edited', artist: 'Artist' }),
  }));
  expect(state.ack).toHaveBeenCalledWith(state.edits[0]);
});

it.each([
  { serverId: 'other-library' }, { id: 'wrong-song' }, { title: 'wrong-title' }, { artist: 'wrong-artist' },
])('retains edits for mismatched response %j', async (changed) => {
  fetchMock.mockResolvedValue(Response.json({ ...accepted(), ...changed }));
  expect(await pushPendingMetadata(state.cfg)).toMatch(/did not match/);
  expect(state.ack).not.toHaveBeenCalled();
});

it('retains edits offline or on an older desktop server, and retries next sync', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await pushPendingMetadata(state.cfg)).toMatch(/Network/);
  expect(state.ack).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect(await pushPendingMetadata(state.cfg)).toMatch(/503/);
  expect(state.ack).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(Response.json(accepted()));
  expect(await pushPendingMetadata(state.cfg)).toBeNull();
  expect(state.ack).toHaveBeenCalledOnce();
});

it.each([404, 412])('keeps unavailable/conflicting edit (%i) without blocking the next song', async (status) => {
  state.edits.push({ ...state.edits[0]!, trackId: 'song-2' });
  fetchMock.mockResolvedValueOnce(new Response(null, { status }));
  fetchMock.mockResolvedValueOnce(Response.json({ ...accepted(), id: 'song-2' }));
  expect(await pushPendingMetadata(state.cfg)).not.toBeNull();
  expect(state.ack).toHaveBeenCalledExactlyOnceWith(state.edits[1]);
});

it('does not acknowledge after pairing changes during the response', async () => {
  fetchMock.mockImplementation(async () => {
    state.pairedId = 'library-b';
    return Response.json(accepted());
  });
  expect(await pushPendingMetadata(state.cfg)).toMatch(/Pairing changed/);
  expect(state.ack).not.toHaveBeenCalled();
});

it('does not send edits belonging to a different library', async () => {
  state.edits[0]!.serverId = 'library-b';
  expect(await pushPendingMetadata(state.cfg)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
