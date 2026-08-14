import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  listUnplaylistedTracks,
  renamePlaylist,
  type PlaylistSummary,
} from '../../src/db/queries';
import { EmptyState } from '../../src/ui/EmptyState';
import { colors } from '../../src/ui/theme';

function formatHours(durationSec: number): string {
  const hours = Math.max(0, durationSec) / 3600;
  if (hours === 0) return '0 hr';
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} hr` : `${rounded.toFixed(1)} hr`;
}

function playlistMeta(playlist: PlaylistSummary): string {
  const songs = `${playlist.trackCount} ${playlist.trackCount === 1 ? 'song' : 'songs'}`;
  return `${songs} · ${formatHours(playlist.durationSec)}`;
}

export default function PlaylistsScreen() {
  const router = useRouter();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>(() => listPlaylists());

  const refresh = useCallback(() => {
    setPlaylists(listPlaylists());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // On device (iOS 18), a repaint that lands while Alert.prompt's keyboard and
  // alert are still tearing down can be swallowed; the simulator never shows
  // this. Refresh immediately, then once more after the teardown has settled —
  // re-reading the list twice is harmless and one of the two always paints.
  const refreshAfterPrompt = useCallback(() => {
    refresh();
    setTimeout(refresh, 400);
  }, [refresh]);

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

  const createEmpty = () => {
    promptForName('New Playlist', '', (name) => {
      createPlaylist(name);
      refreshAfterPrompt();
    });
  };

  const createFromUnsorted = () => {
    const unsorted = listUnplaylistedTracks();
    if (unsorted.length === 0) {
      Alert.alert('No unsorted songs', 'Every song is already in a playlist.');
      return;
    }
    const noun = unsorted.length === 1 ? 'song' : 'songs';
    Alert.prompt(
      'New Playlist',
      `Add ${unsorted.length} ${noun} not in any playlist?`,
      (value) => {
        const name = value.trim();
        if (name === '') {
          Alert.alert('Name required', 'Enter a name for the playlist.');
          return;
        }
        const id = createPlaylist(name);
        addTracksToPlaylist(
          id,
          unsorted.map((track) => track.id),
        );
        refreshAfterPrompt();
      },
      'plain-text',
      'Unsorted',
    );
  };

  const create = () => {
    const unsortedCount = listUnplaylistedTracks().length;
    const noun = unsortedCount === 1 ? 'song' : 'songs';
    Alert.alert(
      'New Playlist',
      unsortedCount === 0 ? undefined : `${unsortedCount} ${noun} are not in any playlist.`,
      [
        {
          text: 'Empty playlist',
          onPress: createEmpty,
        },
        ...(unsortedCount === 0
          ? []
          : [{ text: 'Add unsorted songs', onPress: createFromUnsorted }]),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const rename = (playlist: PlaylistSummary) => {
    promptForName('Rename Playlist', playlist.name, (name) => {
      renamePlaylist(playlist.id, name);
      refreshAfterPrompt();
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
        extraData={playlists}
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
