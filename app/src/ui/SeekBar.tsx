import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { colors } from './theme';

/**
 * Dependency-free seek bar: tap or drag anywhere on the bar to seek.
 */
export function SeekBar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const [scrubX, setScrubX] = useState<number | null>(null);
  const widthRef = useRef(0);

  const fractionFromEvent = (e: GestureResponderEvent): number => {
    const w = widthRef.current;
    if (w <= 0) return 0;
    return Math.max(0, Math.min(1, e.nativeEvent.locationX / w));
  };

  const progress =
    scrubX !== null && width > 0
      ? scrubX / width
      : duration > 0
        ? Math.max(0, Math.min(1, position / duration))
        : 0;

  return (
    <View
      style={styles.touchArea}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => setScrubX(fractionFromEvent(e) * widthRef.current)}
      onResponderMove={(e) => setScrubX(fractionFromEvent(e) * widthRef.current)}
      onResponderRelease={(e) => {
        setScrubX(null);
        if (duration > 0) onSeek(fractionFromEvent(e) * duration);
      }}
      onResponderTerminate={() => setScrubX(null)}
    >
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={[styles.thumb, { left: Math.max(0, progress * width - 6) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    height: 32,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    backgroundColor: colors.accent,
  },
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.text,
  },
});
