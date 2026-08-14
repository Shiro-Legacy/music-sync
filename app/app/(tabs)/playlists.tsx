import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  renamePlaylist,
  type PlaylistSummary,
} from '../../src/db/queries';
import { EmptyState } from '../../src/ui/EmptyState';
import { colors } from '../../src/ui/theme';

function playlistMeta(playlist: PlaylistSummary): string {
  const songs = `${playlist.trackCount} ${playlist.trackCount === 1 ? 'song' : 'songs'}`;
  const minutes = Math.round(playlist.durationSec / 60);
  return `${songs} · ${minutes} min`;
}

export default function PlaylistsScreen() {
  const router = useRouter();
  const [version, setVersion] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setVersion((value) => value + 1);
    }, []),
  );

  const playlists = useMemo(() => listPlaylists(), [version]);
  const refresh = () => setVersion((value) => value + 1);

  const promptForName = (title: string, initialName: string, onSave: (name: string) => void) => {
    Alert.prompt(
      title,
      undefined,
      (value) => {
        const name = value.trim();
        if (name === '') {
          Alert.alert('Name required', 'Enter a name for the playlist.');
          return;
        }
        onSave(name);
      },
      'plain-text',
      initialName,
    );
  };

  const create = () => {
    promptForName('New Playlist', '', (name) => {
      createPlaylist(name);
      refresh();
    });
  };

  const rename = (playlist: PlaylistSummary) => {
    promptForName('Rename Playlist', playlist.name, (name) => {
      renamePlaylist(playlist.id, name);
      refresh();
    });
  };

  const confirmDelete = (playlist: PlaylistSummary) => {
    Alert.alert('Delete Playlist?', `“${playlist.name}” will be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deletePlaylist(playlist.id);
          refresh();
        },
      },
    ]);
  };

  const showActions = (playlist: PlaylistSummary) => {
    Alert.alert(playlist.name, undefined, [
      { text: 'Rename', onPress: () => rename(playlist) },
      { text: 'Delete', style: 'destructive', onPress: () => confirmDelete(playlist) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          onPress={create}
          style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
        >
          <Text style={styles.newButtonLabel}>＋ New Playlist</Text>
        </Pressable>
      </View>
      <FlashList
        data={playlists}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <EmptyState title="No playlists yet" subtitle="Create a playlist to collect your songs." />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/library/playlist/[id]', params: { id: String(item.id) } })
            }
            onLongPress={() => showActions(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowBody}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta}>{playlistMeta(item)}</Text>
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
  toolbar: {
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
  newButton: {
    borderRadius: 10,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  newButtonLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
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
