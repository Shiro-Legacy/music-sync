import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { listAlbums, listSongsByArtist } from '../../../src/db/queries';
import { albumKey } from '../../../src/lib/albumKey';
import { playContext } from '../../../src/player/queue';
import { EmptyState } from '../../../src/ui/EmptyState';
import { SectionHeader } from '../../../src/ui/SectionHeader';
import { TrackRow } from '../../../src/ui/TrackRow';
import { colors } from '../../../src/ui/theme';

export default function ArtistScreen() {
  const router = useRouter();
  const { artist: artistParam } = useLocalSearchParams<{ artist: string }>();
  const artist = artistParam ?? '';

  const albums = useMemo(() => listAlbums(artist), [artist]);
  const songs = useMemo(() => listSongsByArtist(artist), [artist]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: artist }} />
      <FlashList
        data={songs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            {albums.length > 0 && (
              <View>
                <SectionHeader title="Albums" />
                {albums.map((album) => (
                  <Pressable
                    key={`${album.albumArtist}:::${album.album}`}
                    onPress={() =>
                      router.push({
                        pathname: '/library/album/[key]',
                        params: { key: albumKey(album.albumArtist, album.album) },
                      })
                    }
                    style={({ pressed }) => [styles.albumRow, pressed && styles.pressed]}
                  >
                    <View style={styles.albumBody}>
                      <Text numberOfLines={1} style={styles.albumTitle}>
                        {album.album}
                      </Text>
                      <Text style={styles.albumMeta}>
                        {album.year !== null ? `${album.year} · ` : ''}
                        {album.trackCount} {album.trackCount === 1 ? 'song' : 'songs'}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {songs.length > 0 && <SectionHeader title="Songs" />}
          </View>
        }
        ListEmptyComponent={<EmptyState title="Nothing by this artist" />}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            showArtist={false}
            onPress={() => void playContext(songs, index)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  listContent: {
    paddingBottom: 60,
  },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  pressed: {
    backgroundColor: colors.card,
  },
  albumBody: {
    flex: 1,
    gap: 2,
  },
  albumTitle: {
    color: colors.text,
    fontSize: 16,
  },
  albumMeta: {
    color: colors.textDim,
    fontSize: 13,
  },
  chevron: {
    color: colors.textDim,
    fontSize: 22,
  },
});
