import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, {
  RepeatMode,
  useIsPlaying,
  useProgress,
} from 'react-native-track-player';

import { useCurrentTrack } from '../src/player/useCurrentTrack';
import { toggleShuffle } from '../src/player/queue';
import { usePlayerStore } from '../src/store/playerStore';
import { SeekBar } from '../src/ui/SeekBar';
import { artSideFor } from '../src/ui/playerLayout';
import { colors, formatDuration } from '../src/ui/theme';

const REPEAT_CYCLE: RepeatMode[] = [RepeatMode.Off, RepeatMode.Queue, RepeatMode.Track];

export default function PlayerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  const track = useCurrentTrack();
  const { playing } = useIsPlaying();
  const progress = useProgress(250);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(RepeatMode.Off);
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);
  // Art stage measured at layout: on small screens (iPhone SE, 667pt) the
  // fixed blocks below leave less height than the content width, so the
  // square art must shrink to the leftover instead of overflowing controls.
  const [artSide, setArtSide] = useState<number | null>(null);

  // Short screens (iPhone SE) or large Dynamic Type shed ~44pt of vertical block
  // margins: at extreme font scales the fixed blocks alone outgrow 667pt, and no
  // artwork can fix a column that already overflows before the art is added.
  const compact = height <= 700 || fontScale >= 1.5;

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
  const shownPosition = scrubSeconds ?? progress.position;
  const repeatLabel =
    repeatMode === RepeatMode.Off
      ? 'Repeat off'
      : repeatMode === RepeatMode.Queue
        ? 'Repeat all'
        : 'Repeat one';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
      <Pressable
        hitSlop={12}
        onPress={() => router.back()}
        style={styles.dismiss}
        accessibilityRole="button"
        accessibilityLabel="Close player"
      >
        <SymbolView name="chevron.down" size={22} tintColor={colors.textDim} weight="semibold" />
      </Pressable>

      <View
        style={styles.stage}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setArtSide(artSideFor(width, height));
        }}
      >
        {artSide !== null && artSide > 0 &&
          (artwork !== undefined ? (
            <Image source={{ uri: artwork }} style={[styles.art, { width: artSide, height: artSide }]} />
          ) : (
            <View style={[styles.art, styles.artPlaceholder, { width: artSide, height: artSide }]}>
              <SymbolView name="music.note" size={84} tintColor={colors.textDim} />
            </View>
          ))}
      </View>

      <View style={[styles.meta, compact && styles.compactBlock]}>
        <Text numberOfLines={2} style={styles.title}>
          {track?.title ?? 'Nothing playing'}
        </Text>
        <Text numberOfLines={1} style={styles.artist}>
          {track?.artist ?? ''}
          {track?.album !== undefined && track.album !== '' ? ` — ${String(track.album)}` : ''}
        </Text>
      </View>

      <View style={[styles.seekArea, compact && styles.compactBlock]}>
        <SeekBar
          position={progress.position}
          duration={duration}
          onSeek={(seconds) => void TrackPlayer.seekTo(seconds)}
          onScrub={setScrubSeconds}
        />
        <View style={styles.times}>
          <Text style={styles.time}>{formatDuration(shownPosition)}</Text>
          <Text style={styles.time}>-{formatDuration(Math.max(0, duration - shownPosition))}</Text>
        </View>
      </View>

      <View style={[styles.controls, compact && styles.compactBlock]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}
          hitSlop={10}
          onPress={() => void toggleShuffle()}
          style={styles.sideButton}
        >
          <SymbolView name="shuffle" size={22} tintColor={shuffle ? colors.accent : colors.textDim} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous song"
          hitSlop={10}
          onPress={() => void TrackPlayer.skipToPrevious()}
        >
          <SymbolView name="backward.fill" size={32} tintColor={colors.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing === true ? 'Pause' : 'Play'}
          hitSlop={10}
          onPress={() => {
            if (playing === true) void TrackPlayer.pause();
            else void TrackPlayer.play();
          }}
          style={styles.playButton}
        >
          <SymbolView
            name={playing === true ? 'pause.fill' : 'play.fill'}
            size={32}
            tintColor={colors.text}
            style={playing === true ? undefined : styles.playOffset}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next song"
          hitSlop={10}
          onPress={() => void TrackPlayer.skipToNext()}
        >
          <SymbolView name="forward.fill" size={32} tintColor={colors.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={repeatLabel}
          hitSlop={10}
          onPress={() => void cycleRepeat()}
          style={styles.sideButton}
        >
          <SymbolView
            name={repeatMode === RepeatMode.Track ? 'repeat.1' : 'repeat'}
            size={22}
            tintColor={repeatMode === RepeatMode.Off ? colors.textDim : colors.accent}
          />
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
  stage: {
    alignSelf: 'stretch',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  art: {
    borderRadius: 14,
  },
  artPlaceholder: {
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactBlock: {
    marginTop: 12,
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
  playButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playOffset: {
    marginLeft: 4,
  },
});
