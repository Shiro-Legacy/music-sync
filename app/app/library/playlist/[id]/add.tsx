import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActiveTrack } from 'react-native-track-player';

import {
  addTracksToPlaylist,
  listPlaylists,
  listSongs,
  playlistTracks,
} from '../../../../src/db/queries';
import { EmptyState } from '../../../../src/ui/EmptyState';
import { MINI_PLAYER_HEIGHT } from '../../../../src/ui/MiniPlayer';
import { colors } from '../../../../src/ui/theme';

function parsePlaylistId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function AddSongsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const activeTrack = useActiveTrack();
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const id = parsePlaylistId(idParam);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const existingIds = useMemo(
    () => new Set(id === null ? [] : playlistTracks(id).map((track) => track.id)),
    [id],
  );
  const songs = useMemo(
    () => listSongs(search).filter((track) => !existingIds.has(track.id)),
    [existingIds, search],
  );
  const playlistName = useMemo(
    () => (id === null ? undefined : listPlaylists().find((playlist) => playlist.id === id)?.name),
    [id],
  );

  const toggle = (trackId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const add = () => {
    if (id === null || selected.size === 0) return;
    addTracksToPlaylist(id, [...selected]);
    router.back();
  };

  const addAllFiltered = () => {
    if (id === null || songs.length === 0) return;
    addTracksToPlaylist(
      id,
      songs.map((track) => track.id),
    );
    router.back();
  };

  const confirmAddAll = () => {
    if (id === null || songs.length === 0) return;
    if (songs.length <= 50) {
      addAllFiltered();
      return;
    }
    const noun = songs.length === 1 ? 'song' : 'songs';
    const target = playlistName ?? 'this playlist';
    Alert.alert(`Add ${songs.length} ${noun} to ${target}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add', onPress: addAllFiltered },
    ]);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Add Songs',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: songs.length === 0 }}
              disabled={songs.length === 0}
              onPress={confirmAddAll}
            >
              <Text style={[styles.addAllLabel, songs.length === 0 && styles.addAllLabelDisabled]}>
                Add all ({songs.length})
              </Text>
            </Pressable>
          ),
        }}
      />
      <TextInput
        style={styles.search}
        placeholder="Search songs"
        placeholderTextColor={colors.textDim}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <FlashList
        data={songs}
        extraData={selected}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <EmptyState
            title={search.trim() === '' ? 'No songs to add' : 'No matching songs'}
            subtitle="Songs already in this playlist are hidden."
          />
        }
        renderItem={({ item }) => {
          const checked = selected.has(item.id);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              onPress={() => toggle(item.id)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.rowBody}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={styles.rowSubtitle}>
                  {[item.artist, item.album].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <View style={[styles.check, checked && styles.checkSelected]}>
                <Text style={[styles.checkLabel, checked && styles.checkLabelSelected]}>
                  {checked ? '✓' : ''}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
      <View
        style={[
          styles.footer,
          {
            paddingBottom:
              Math.max(insets.bottom, 12) + (activeTrack === undefined ? 0 : MINI_PLAYER_HEIGHT),
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: selected.size === 0 }}
          disabled={selected.size === 0}
          onPress={add}
          style={({ pressed }) => [
            styles.addButton,
            selected.size === 0 && styles.addButtonDisabled,
            pressed && styles.addButtonPressed,
          ]}
        >
          <Text style={[styles.addButtonLabel, selected.size === 0 && styles.addLabelDisabled]}>
            Add ({selected.size})
          </Text>
        </Pressable>
      </View>
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
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 16,
  },
  listContent: {
    paddingBottom: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  pressed: {
    backgroundColor: colors.card,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 16,
  },
  rowSubtitle: {
    color: colors.textDim,
    fontSize: 13,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkLabel: {
    color: colors.textDim,
    fontSize: 15,
    fontWeight: '700',
  },
  checkLabelSelected: {
    color: colors.bg,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  addButton: {
    alignItems: 'center',
    borderRadius: 11,
    backgroundColor: colors.accent,
    paddingVertical: 12,
  },
  addButtonDisabled: {
    backgroundColor: colors.card,
  },
  addButtonPressed: {
    opacity: 0.8,
  },
  addButtonLabel: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
  addLabelDisabled: {
    color: colors.textDim,
  },
  addAllLabel: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  addAllLabelDisabled: {
    color: colors.textDim,
  },
});
