import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, {
  RepeatMode,
  useActiveTrack,
  useIsPlaying,
  useProgress,
} from 'react-native-track-player';

import { shuffleRemaining } from '../src/player/queue';
import { SeekBar } from '../src/ui/SeekBar';
import { colors, formatDuration } from '../src/ui/theme';

const REPEAT_CYCLE: RepeatMode[] = [RepeatMode.Off, RepeatMode.Queue, RepeatMode.Track];

function repeatGlyph(mode: RepeatMode): string {
  switch (mode) {
    case RepeatMode.Track:
      return '🔂';
    case RepeatMode.Queue:
      return '🔁';
    default:
      return '↻';
  }
}

export default function PlayerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();
  const progress = useProgress(500);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(RepeatMode.Off);

  useEffect(() => {
    void TrackPlayer.getRepeatMode().then(setRepeatMode);
  }, []);

  const cycleRepeat = async () => {
    const index = REPEAT_CYCLE.indexOf(repeatMode);
    const next = REPEAT_CYCLE[(index + 1) % REPEAT_CYCLE.length]!;
    await TrackPlayer.setRepeatMode(next);
    setRepeatMode(next);
  };

  const artwork = typeof track?.artwork === 'string' ? track.artwork : undefined;
  const duration = progress.duration > 0 ? progress.duration : (track?.duration ?? 0);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
      <Pressable hitSlop={12} onPress={() => router.back()} style={styles.dismiss}>
        <Text style={styles.dismissGlyph}>⌄</Text>
      </Pressable>

      {artwork !== undefined ? (
        <Image source={{ uri: artwork }} style={styles.art} />
      ) : (
        <View style={[styles.art, styles.artPlaceholder]}>
          <Text style={styles.artGlyph}>♪</Text>
        </View>
      )}

      <View style={styles.meta}>
        <Text numberOfLines={2} style={styles.title}>
          {track?.title ?? 'Nothing playing'}
        </Text>
        <Text numberOfLines={1} style={styles.artist}>
          {track?.artist ?? ''}
          {track?.album !== undefined && track.album !== '' ? ` — ${String(track.album)}` : ''}
        </Text>
      </View>

      <View style={styles.seekArea}>
        <SeekBar
          position={progress.position}
          duration={duration}
          onSeek={(seconds) => void TrackPlayer.seekTo(seconds)}
        />
        <View style={styles.times}>
          <Text style={styles.time}>{formatDuration(progress.position)}</Text>
          <Text style={styles.time}>-{formatDuration(Math.max(0, duration - progress.position))}</Text>
        </View>
      </View>

      <View style={styles.controls}>
        <Pressable hitSlop={10} onPress={() => void shuffleRemaining()} style={styles.sideButton}>
          <Text style={styles.sideGlyph}>⤨</Text>
        </Pressable>
        <Pressable hitSlop={10} onPress={() => void TrackPlayer.skipToPrevious()}>
          <Text style={styles.transportGlyph}>⏮</Text>
        </Pressable>
        <Pressable
          hitSlop={10}
          onPress={() => {
            if (playing === true) void TrackPlayer.pause();
            else void TrackPlayer.play();
          }}
          style={styles.playButton}
        >
          <Text style={styles.playGlyph}>{playing === true ? '❚❚' : '▶'}</Text>
        </Pressable>
        <Pressable hitSlop={10} onPress={() => void TrackPlayer.skipToNext()}>
          <Text style={styles.transportGlyph}>⏭</Text>
        </Pressable>
        <Pressable hitSlop={10} onPress={() => void cycleRepeat()} style={styles.sideButton}>
          <Text
            style={[
              styles.sideGlyph,
              repeatMode !== RepeatMode.Off && { color: colors.accent },
            ]}
          >
            {repeatGlyph(repeatMode)}
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
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  dismiss: {
    alignSelf: 'center',
    marginBottom: 8,
  },
  dismissGlyph: {
    color: colors.textDim,
    fontSize: 24,
  },
  art: {
    width: '100%',
    aspectRatio: 1,
    maxHeight: 360,
    borderRadius: 14,
    marginTop: 12,
  },
  artPlaceholder: {
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artGlyph: {
    color: colors.textDim,
    fontSize: 84,
  },
  meta: {
    marginTop: 28,
    alignSelf: 'stretch',
    gap: 6,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  artist: {
    color: colors.textDim,
    fontSize: 16,
  },
  seekArea: {
    alignSelf: 'stretch',
    marginTop: 24,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  time: {
    color: colors.textDim,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    marginTop: 28,
    paddingHorizontal: 8,
  },
  sideButton: {
    width: 44,
    alignItems: 'center',
  },
  sideGlyph: {
    color: colors.textDim,
    fontSize: 22,
  },
  transportGlyph: {
    color: colors.text,
    fontSize: 34,
  },
  playButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    color: colors.text,
    fontSize: 30,
  },
});
