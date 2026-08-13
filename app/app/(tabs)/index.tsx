import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  listAlbums,
  listArtists,
  listSongs,
  type AlbumSummary,
  type ArtistSummary,
  type TrackRow as TrackRowData,
} from '../../src/db/queries';
import { albumKey } from '../../src/lib/albumKey';
import { playContext } from '../../src/player/queue';
import { EmptyState } from '../../src/ui/EmptyState';
import { TrackRow } from '../../src/ui/TrackRow';
import { colors } from '../../src/ui/theme';

type Segment = 'artists' | 'albums' | 'songs';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'artists', label: 'Artists' },
  { key: 'albums', label: 'Albums' },
  { key: 'songs', label: 'Songs' },
];

export default function LibraryScreen() {
  const router = useRouter();
  const [segment, setSegment] = useState<Segment>('artists');
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setRefreshKey((k) => k + 1);
    }, []),
  );

  const artists = useMemo<ArtistSummary[]>(() => {
    if (segment !== 'artists') return [];
    const all = listArtists();
    const q = search.trim().toLowerCase();
    return q === '' ? all : all.filter((a) => a.artist.toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, search, refreshKey]);

  const albums = useMemo<AlbumSummary[]>(() => {
    if (segment !== 'albums') return [];
    const all = listAlbums();
    const q = search.trim().toLowerCase();
    return q === ''
      ? all
      : all.filter(
          (a) => a.album.toLowerCase().includes(q) || a.albumArtist.toLowerCase().includes(q),
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, search, refreshKey]);

  const songs = useMemo<TrackRowData[]>(() => {
    if (segment !== 'songs') return [];
    return listSongs(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, search, refreshKey]);

  const openAlbum = (album: AlbumSummary) => {
    router.push({
      pathname: '/library/album/[key]',
      params: { key: albumKey(album.albumArtist, album.album) },
    });
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        placeholder="Search"
        placeholderTextColor={colors.textDim}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <View style={styles.segments}>
        {SEGMENTS.map(({ key, label }) => (
          <Pressable
            key={key}
            onPress={() => setSegment(key)}
            style={[styles.segment, segment === key && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, segment === key && styles.segmentLabelActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {segment === 'artists' && (
        <FlashList
          data={artists}
          keyExtractor={(item) => item.artist}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No artists yet"
              subtitle="Pair with your desktop server and sync to fill your library."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() =>
                router.push({ pathname: '/library/artist/[artist]', params: { artist: item.artist } })
              }
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.artist}
              </Text>
              <Text style={styles.rowMeta}>
                {item.trackCount} {item.trackCount === 1 ? 'song' : 'songs'}
              </Text>
            </Pressable>
          )}
        />
      )}

      {segment === 'albums' && (
        <FlashList
          data={albums}
          keyExtractor={(item) => `${item.albumArtist}:::${item.album}`}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No albums yet"
              subtitle="Pair with your desktop server and sync to fill your library."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => openAlbum(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowBody}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {item.album}
                </Text>
                <Text numberOfLines={1} style={styles.rowSubtitle}>
                  {item.albumArtist}
                  {item.year !== null ? ` · ${item.year}` : ''}
                </Text>
              </View>
              <Text style={styles.rowMeta}>{item.trackCount}</Text>
            </Pressable>
          )}
        />
      )}

      {segment === 'songs' && (
        <FlashList
          data={songs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No songs yet"
              subtitle="Pair with your desktop server and sync to fill your library."
            />
          }
          renderItem={({ item, index }) => (
            <TrackRow track={item} onPress={() => void playContext(songs, index)} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 16,
  },
  segments: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 10,
    backgroundColor: colors.card,
    borderRadius: 9,
    padding: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 7,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: colors.border,
  },
  segmentLabel: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  segmentLabelActive: {
    color: colors.text,
  },
  listContent: {
    paddingBottom: 140,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  rowPressed: {
    backgroundColor: colors.card,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 16,
    flexShrink: 1,
    flexGrow: 1,
  },
  rowSubtitle: {
    color: colors.textDim,
    fontSize: 13,
  },
  rowMeta: {
    color: colors.textDim,
    fontSize: 13,
  },
});
