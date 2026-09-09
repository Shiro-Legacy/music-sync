import { TrackMetadataPatchSchema } from '@music-sync/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { byId, getServerConfig, listPendingMetadata, saveTrackMetadata } from '../../../../src/db/queries';
import { refreshQueueMetadata } from '../../../../src/player/queue';
import { useSyncStore } from '../../../../src/store/syncStore';
import { runSync } from '../../../../src/sync/engine';
import { EmptyState } from '../../../../src/ui/EmptyState';
import { colors } from '../../../../src/ui/theme';

export default function EditSongScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [track] = useState(() => byId(id));
  const [serverId] = useState(() => getServerConfig()?.serverId);
  const [draft] = useState(() => serverId === undefined ? undefined : listPendingMetadata(serverId).find((edit) => edit.trackId === id));
  const [title, setTitle] = useState(draft?.title ?? track?.title ?? '');
  const [artist, setArtist] = useState(draft?.artist ?? track?.artist ?? '');
  const [error, setError] = useState<string | null>(null);
  const syncStatus = useSyncStore((state) => state.status);
  const pending = serverId !== undefined && listPendingMetadata(serverId).some((edit) => edit.trackId === id);

  const save = () => {
    const parsed = TrackMetadataPatchSchema.safeParse({ title, artist });
    if (!parsed.success) {
      setError('Enter a title and artist, each 1–300 characters without control characters.');
      return;
    }
    try {
      if (serverId === undefined) throw new Error('Pair and sync your library before editing songs.');
      if (byId(id)?.contentKey !== track?.contentKey) {
        throw new Error('The desktop file changed while you were editing. Reopen Edit Song to review it before saving.');
      }
      saveTrackMetadata(id, parsed.data.title, parsed.data.artist, serverId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    void refreshQueueMetadata().catch((cause) => console.warn('[player] metadata refresh failed', cause));
    void runSync('manual');
    router.back();
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Edit Song' }} />
      {track === null ? <EmptyState title="Song not found" /> : (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {draft !== undefined && draft.contentKey !== track.contentKey && (
            <Text accessibilityRole="alert" style={styles.error}>
              The desktop file changed. These are your unsent edits; saving will apply them to the replacement song (“{track.title}” by {track.artist}).
            </Text>
          )}
          <Text style={styles.label}>Song title</Text>
          <TextInput accessibilityLabel="Song title" style={styles.input} value={title} onChangeText={setTitle} maxLength={300} />
          <Text style={styles.label}>Artist</Text>
          <TextInput accessibilityLabel="Artist" style={styles.input} value={artist} onChangeText={setArtist} maxLength={300} />
          <Text style={styles.note}>
            Saves on this phone immediately. Edits sync to your desktop’s MusicSync library when connected; audio files stay unchanged.
          </Text>
          {pending && <Text style={styles.note}>{syncStatus === 'checking' ? 'Uploading saved edits…' : 'Saved edits are waiting to sync to the desktop.'}</Text>}
          {error !== null && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel="Save song" style={styles.save} onPress={save}>
            <Text style={styles.saveLabel}>Save</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 12 },
  label: { color: colors.text, fontSize: 16, fontWeight: '600' },
  input: { color: colors.text, backgroundColor: colors.card, borderRadius: 10, padding: 14, fontSize: 17 },
  note: { color: colors.textDim, fontSize: 14 },
  error: { color: colors.danger, fontSize: 14 },
  save: { backgroundColor: colors.accent, padding: 14, borderRadius: 10, alignItems: 'center' },
  saveLabel: { color: colors.bg, fontSize: 17, fontWeight: '600' },
});
