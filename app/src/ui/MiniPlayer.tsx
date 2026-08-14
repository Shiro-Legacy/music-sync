import { useRouter, useSegments } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef } from 'react';
import { Animated, Image, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TrackPlayer, { useActiveTrack, useIsPlaying } from 'react-native-track-player';

import { clearQueue } from '../player/queue';
import { colors } from './theme';

/** Approximate iOS bottom tab bar height (excluding the home indicator inset). */
const TAB_BAR_HEIGHT = 49;

/** Height reserved by screens that have bottom-anchored controls of their own. */
export const MINI_PLAYER_HEIGHT = 52;

/**
 * Navigator-level player chrome. It sits above tabs on tab routes and above
 * the safe area on detail routes, and renders nothing while the queue is empty.
 */
export function MiniPlayer() {
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const track = useActiveTrack();
  const { playing } = useIsPlaying();

  // Swipe down to dismiss: drag follows the finger, then either clears the
  // queue (which unmounts the bar) or springs back.
  const dragY = useRef(new Animated.Value(0)).current;
  const dismissing = useRef(false);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        dragY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => {
        if (!dismissing.current && (gesture.dy > 40 || gesture.vy > 0.6)) {
          dismissing.current = true;
          Animated.timing(dragY, { toValue: 96, duration: 140, useNativeDriver: true }).start(() => {
            void clearQueue().finally(() => {
              // Reset for the next mount in case React reuses this instance.
              dragY.setValue(0);
              dismissing.current = false;
            });
          });
        } else {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const rootSegment = segments[0];
  const isTabRoute = rootSegment === '(tabs)';
  const isLibraryRoute = rootSegment === 'library';
  if (track === undefined || (!isTabRoute && !isLibraryRoute)) return null;

  const artwork = typeof track.artwork === 'string' ? track.artwork : undefined;
  const bottom = insets.bottom + (isTabRoute ? TAB_BAR_HEIGHT : 0);
  const opacity = dragY.interpolate({
    inputRange: [0, 96],
    outputRange: [1, 0.2],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      style={[styles.container, { bottom, opacity, transform: [{ translateY: dragY }] }]}
      {...pan.panHandlers}
    >
      <Pressable style={styles.inner} onPress={() => router.push('/player')}>
        {artwork !== undefined ? (
          <Image source={{ uri: artwork }} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artPlaceholder]}>
            <SymbolView name="music.note" size={16} tintColor={colors.textDim} />
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
          accessibilityLabel={playing === true ? 'Pause' : 'Play'}
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => {
            if (playing === true) void TrackPlayer.pause();
            else void TrackPlayer.play();
          }}
          style={styles.controlButton}
        >
          <SymbolView
            name={playing === true ? 'pause.fill' : 'play.fill'}
            size={20}
            tintColor={colors.text}
          />
        </Pressable>
        <Pressable
          accessibilityLabel="Next song"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => void TrackPlayer.skipToNext()}
          style={styles.controlButton}
        >
          <SymbolView name="forward.fill" size={20} tintColor={colors.text} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 10,
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
  controlButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
