import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  listPlaylists,
  playlistTracks,
  removeTrackFromPlaylist,
  type TrackRow as TrackRowData,
} from '../../../src/db/queries';
import { playContext } from '../../../src/player/queue';
import { EmptyState } from '../../../src/ui/EmptyState';
import { TrackRow } from '../../../src/ui/TrackRow';
import { colors } from '../../../src/ui/theme';

function parsePlaylistId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function PlaylistScreen() {
  const router = useRouter();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const id = parsePlaylistId(idParam);
  const [version, setVersion] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setVersion((value) => value + 1);
    }, []),
  );

  const playlist = useMemo(
    () => (id === null ? undefined : listPlaylists().find((item) => item.id === id)),
    [id, version],
  );
  const tracks = useMemo<TrackRowData[]>(
    () => (id === null ? [] : playlistTracks(id)),
    [id, version],
  );
  const refresh = () => setVersion((value) => value + 1);

  const confirmRemove = (track: TrackRowData) => {
    if (id === null) return;
    Alert.alert('Remove Song?', `Remove “${track.title}” from this playlist?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          removeTrackFromPlaylist(id, track.id);
          refresh();
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: playlist?.name ?? 'Playlist',
          headerRight:
            id === null || playlist === undefined
              ? undefined
              : () => (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: '/library/playlist/[id]/add',
                        params: { id: String(id) },
                      })
                    }
                  >
                    <Text style={styles.addLabel}>Add Songs</Text>
                  </Pressable>
                ),
        }}
      />
      <FlashList
        data={tracks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          playlist === undefined ? null : (
            <View style={styles.header}>
              <Text numberOfLines={2} style={styles.title}>
                {playlist.name}
              </Text>
              <Text style={styles.meta}>
                {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
              </Text>
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
          )
        }
        ListEmptyComponent={
          <EmptyState
            title={playlist === undefined ? 'Playlist not found' : 'No songs yet'}
            subtitle={playlist === undefined ? undefined : 'Tap Add Songs to choose from your library.'}
          />
        }
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            onPress={() => void playContext(tracks, index)}
            onLongPress={() => confirmRemove(item)}
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
  addLabel: {
    color: colors.accent,
    fontSize: 16,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 10,
    gap: 4,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  meta: {
    color: colors.textDim,
    fontSize: 14,
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
