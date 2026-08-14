import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { albumTracks } from '../../../src/db/queries';
import { parseAlbumKey } from '../../../src/lib/albumKey';
import { playContext } from '../../../src/player/queue';
import { localArtworkUri } from '../../../src/sync/paths';
import { EmptyState } from '../../../src/ui/EmptyState';
import { TrackRow } from '../../../src/ui/TrackRow';
import { colors } from '../../../src/ui/theme';

export default function AlbumScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const [albumArtist, album] = useMemo(() => parseAlbumKey(key ?? ''), [key]);

  const tracks = useMemo(() => albumTracks(albumArtist, album), [albumArtist, album]);

  const artworkId = tracks.find((t) => t.artworkId !== null)?.artworkId ?? null;
  const artwork = artworkId !== null ? localArtworkUri(artworkId) : null;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: album }} />
      <FlashList
        data={tracks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.header}>
            {artwork !== null ? (
              <Image source={{ uri: artwork }} style={styles.art} />
            ) : (
              <View style={[styles.art, styles.artPlaceholder]}>
                <Text style={styles.artGlyph}>♪</Text>
              </View>
            )}
            <Text style={styles.albumTitle}>{album}</Text>
            <Text style={styles.albumArtist}>{albumArtist}</Text>
            <View style={styles.actions}>
              <Pressable
                style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
                onPress={() => void playContext(tracks, 0)}
              >
                <Text style={styles.actionLabel}>▶ Play</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
                onPress={() => void playContext(tracks, 0, { shuffle: true })}
              >
                <Text style={styles.actionLabel}>⤨ Shuffle</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={<EmptyState title="Album not found" />}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            showArtist={false}
            onPress={() => void playContext(tracks, index)}
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
    paddingBottom: 140,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 4,
  },
  art: {
    width: 180,
    height: 180,
    borderRadius: 10,
    marginBottom: 10,
  },
  artPlaceholder: {
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artGlyph: {
    color: colors.textDim,
    fontSize: 48,
  },
  albumTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  albumArtist: {
    color: colors.textDim,
    fontSize: 15,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    marginBottom: 6,
  },
  actionButton: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 26,
    paddingVertical: 10,
  },
  actionPressed: {
    backgroundColor: colors.border,
  },
  actionLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
});
