import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { TrackRow as TrackRowData } from '../db/queries';
import { colors, formatDuration } from './theme';

function stateBadge(state: TrackRowData['state']): { label: string; color: string } {
  switch (state) {
    case 'synced':
      return { label: '●', color: colors.success };
    case 'downloading':
      return { label: '↓', color: colors.accent };
    case 'failed':
      return { label: '!', color: colors.danger };
    case 'queued':
      return { label: '◌', color: colors.textDim };
  }
}

export function TrackRow({
  track,
  active = false,
  showArtist = true,
  onPress,
  onLongPress,
}: {
  track: TrackRowData;
  active?: boolean;
  showArtist?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const router = useRouter();
  const badge = stateBadge(track.state);
  const showActions = onLongPress ?? (() => Alert.alert(track.title, undefined, [
    { text: 'Edit Song', onPress: () => router.push({ pathname: '/library/song/[id]/edit', params: { id: track.id } }) },
    { text: 'Cancel', style: 'cancel' },
  ]));
  return (
    <Pressable
      onPress={onPress}
      onLongPress={showActions}
      accessibilityRole="button"
      accessibilityHint="Double tap to play. Long press for song options."
      accessibilityActions={[{ name: 'longpress', label: 'Song options' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') showActions();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {track.trackNo !== null && !showArtist ? (
        <Text style={styles.trackNo}>{track.trackNo}</Text>
      ) : null}
      <View style={styles.body}>
        <Text
          numberOfLines={1}
          style={[styles.title, active && { color: colors.accent }]}
        >
          {track.title}
        </Text>
        {showArtist && (
          <Text numberOfLines={1} style={styles.subtitle}>
            {track.artist}
          </Text>
        )}
      </View>
      <Text style={[styles.badge, { color: badge.color }]}>{badge.label}</Text>
      <Text style={styles.duration}>{formatDuration(track.durationSec)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  pressed: {
    backgroundColor: colors.card,
  },
  trackNo: {
    color: colors.textDim,
    fontSize: 14,
    width: 24,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 16,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 13,
  },
  badge: {
    fontSize: 12,
    width: 14,
    textAlign: 'center',
  },
  duration: {
    color: colors.textDim,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
});
