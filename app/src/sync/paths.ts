import { Directory, File, Paths } from 'expo-file-system';

import { setExcludedFromBackup } from '../../modules/backup-exclusion';
import type { TrackRow } from '../db/queries';

export function musicDir(): Directory {
  return new Directory(Paths.document, 'Music');
}

export function artworkDir(): Directory {
  return new Directory(Paths.document, 'Artwork');
}

/** Creates Documents/Music and Documents/Artwork and excludes them from iCloud backup. */
export function ensureDirs(): void {
  const music = musicDir();
  if (!music.exists) music.create({ intermediates: true });
  const artwork = artworkDir();
  if (!artwork.exists) artwork.create({ intermediates: true });
  setExcludedFromBackup(music.uri);
  setExcludedFromBackup(artwork.uri);
}

export function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

export function pathToUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** File extension for a track: taken from its server path, falling back to its format. */
export function extForTrack(row: Pick<TrackRow, 'path' | 'format'>): string {
  const dot = row.path.lastIndexOf('.');
  if (dot >= 0) {
    const ext = row.path.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  // ALAC lives in an .m4a container; other playable formats match their extension.
  return row.format === 'alac' ? 'm4a' : row.format;
}

export function trackFileName(row: Pick<TrackRow, 'id' | 'path' | 'format'>): string {
  return `${row.id}.${extForTrack(row)}`;
}

/** file:// URI where a track is (or will be) stored locally. */
export function trackFileUri(row: Pick<TrackRow, 'id' | 'path' | 'format'>): string {
  return new File(musicDir(), trackFileName(row)).uri;
}

/** Plain filesystem path for the background downloader's `destination`. */
export function trackDestinationPath(row: Pick<TrackRow, 'id' | 'path' | 'format'>): string {
  return uriToPath(trackFileUri(row));
}

/** Local artwork file URI, or null when it has not been downloaded yet. */
export function localArtworkUri(artworkId: string): string | null {
  const file = new File(artworkDir(), artworkId);
  return file.exists ? file.uri : null;
}
