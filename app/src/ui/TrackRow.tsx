import { Pressable, StyleSheet, Text, View } from 'react-native';

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
}: {
  track: TrackRowData;
  active?: boolean;
  showArtist?: boolean;
  onPress: () => void;
}) {
  const badge = stateBadge(track.state);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
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
