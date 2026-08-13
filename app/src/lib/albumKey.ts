/**
 * Album route key: both halves are URI-component-encoded so a ':::' inside an
 * artist or album name can never collide with the separator.
 */
export function albumKey(albumArtist: string, album: string): string {
  return `${encodeURIComponent(albumArtist)}:::${encodeURIComponent(album)}`;
}

export function parseAlbumKey(key: string): readonly [albumArtist: string, album: string] {
  const idx = key.indexOf(':::');
  if (idx < 0) return [decodeURIComponent(key), ''] as const;
  return [decodeURIComponent(key.slice(0, idx)), decodeURIComponent(key.slice(idx + 3))] as const;
}
