import { apiRoutes, TrackMetadataResponseSchema } from '@music-sync/shared';

import { authedFetch } from '../api/client';
import {
  acknowledgeMetadata,
  getServerConfig,
  listPendingMetadata,
  type ServerConfig,
} from '../db/queries';

/** Upload before fetching the manifest. Failed edits remain durable and visible locally. */
export async function pushPendingMetadata(cfg: ServerConfig): Promise<string | null> {
  let error: string | null = null;
  for (const edit of listPendingMetadata(cfg.serverId)) {
    if (getServerConfig()?.serverId !== cfg.serverId) throw new Error('Pairing changed during sync.');
    try {
      const response = await authedFetch(cfg, apiRoutes.trackMetadata(edit.trackId), {
        method: 'PATCH',
        extraHeaders: { 'X-MusicSync-Server-Id': cfg.serverId, 'If-Match': `"${edit.contentKey}"` },
        body: JSON.stringify({ title: edit.title, artist: edit.artist }),
      });
      if (getServerConfig()?.serverId !== cfg.serverId) throw new Error('Pairing changed during sync.');
      if (response.status === 404 || response.status === 412) {
        error = response.status === 412
          ? `“${edit.title}” changed on the desktop. Open Edit Song and save again to confirm your edits.`
          : `“${edit.title}” is no longer on the desktop. Its edit has not been uploaded.`;
        continue;
      }
      if (!response.ok) throw new Error(`Song edits not uploaded (HTTP ${response.status}). Update/check the desktop server and retry Sync.`);
      const accepted = TrackMetadataResponseSchema.parse(await response.json());
      if (getServerConfig()?.serverId !== cfg.serverId) throw new Error('Pairing changed during sync.');
      if (accepted.serverId !== cfg.serverId || accepted.id !== edit.trackId
        || accepted.title !== edit.title || accepted.artist !== edit.artist) {
        throw new Error('Song edit response did not match this library and edit.');
      }
      acknowledgeMetadata(edit);
    } catch (cause) {
      // One failed connection is enough; don't wait a timeout for every queued edit.
      return cause instanceof Error ? cause.message : String(cause);
    }
  }
  return error;
}
