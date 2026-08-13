import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useActiveTrack, useIsPlaying } from 'react-native-track-player';

import { colors } from './theme';

/** Approximate iOS bottom tab bar height (excluding the home indicator inset). */
const TAB_BAR_HEIGHT = 49;

/**
 * Persistent bar above the tab bar: current track, play/pause, opens the
 * full-screen player modal. Renders nothing while the queue is empty.
 */
export function MiniPlayer() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();

  if (track === undefined) return null;

  const artwork = typeof track.artwork === 'string' ? track.artwork : undefined;

  return (
    <View style={[styles.container, { bottom: TAB_BAR_HEIGHT + insets.bottom }]}>
      <Pressable style={styles.inner} onPress={() => router.push('/player')}>
        {artwork !== undefined ? (
          <Image source={{ uri: artwork }} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artPlaceholder]}>
            <Text style={styles.artGlyph}>♪</Text>
          </View>
        )}
        <View style={styles.meta}>
          <Text numberOfLines={1} style={styles.title}>
            {track.title ?? 'Unknown'}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {track.artist ?? ''}
          </Text>
        </View>
        <Pressable
          hitSlop={12}
          onPress={() => {
            if (playing === true) void TrackPlayer.pause();
            else void TrackPlayer.play();
          }}
          style={styles.playButton}
        >
          <Text style={styles.playGlyph}>{playing === true ? '❚❚' : '▶'}</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 8,
    right: 8,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 10,
  },
  art: {
    width: 36,
    height: 36,
    borderRadius: 6,
  },
  artPlaceholder: {
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artGlyph: {
    color: colors.textDim,
    fontSize: 16,
  },
  meta: {
    flex: 1,
    gap: 1,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  artist: {
    color: colors.textDim,
    fontSize: 12,
  },
  playButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    color: colors.text,
    fontSize: 18,
  },
});
