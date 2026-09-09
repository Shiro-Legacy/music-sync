import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { addTracksToPlaylist, listPlaylists } from '../../../../src/db/queries';
import { EmptyState } from '../../../../src/ui/EmptyState';
import { colors } from '../../../../src/ui/theme';

function parsePlaylistId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function CopyToPlaylistScreen() {
  const router = useRouter();
  const { id: idParam, trackId } = useLocalSearchParams<{ id: string; trackId: string }>();
  const sourceId = parsePlaylistId(idParam);
  const destinations = useMemo(
    () => (sourceId === null ? [] : listPlaylists().filter((playlist) => playlist.id !== sourceId)),
    [sourceId],
  );

  const copyTo = (playlistId: number) => {
    if (typeof trackId !== 'string' || trackId === '') return;
    addTracksToPlaylist(playlistId, [trackId]);
    router.back();
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Copy to Playlist' }} />
      <FlashList
        data={destinations}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <EmptyState title="No other playlists" subtitle="Create another playlist first." />
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => copyTo(item.id)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowBody}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta}>
                {item.trackCount} {item.trackCount === 1 ? 'song' : 'songs'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  pressed: {
    backgroundColor: colors.border,
  },
  rowBody: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowMeta: {
    color: colors.textDim,
    fontSize: 13,
  },
  chevron: {
    color: colors.textDim,
    fontSize: 22,
  },
});
