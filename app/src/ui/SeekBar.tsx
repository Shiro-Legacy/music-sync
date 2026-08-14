import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { colors } from './theme';

const THUMB = 14;
const THUMB_ACTIVE = 22;

/**
 * Dependency-free seek bar: tap or drag anywhere on the bar to seek.
 *
 * Scrub math uses pageX against the bar's measured window offset — locationX
 * is relative to whichever child view is under the finger (track/fill/thumb),
 * so it jumps between coordinate spaces mid-drag.
 *
 * The fill/thumb are driven by an Animated.Value written directly from touch
 * events, so tracking never waits on a React re-render; `onScrub` label
 * updates are throttled separately. After release (or a native gesture
 * stealing the touch) the released position is committed and held until
 * playback reports a position near it, so the bar never snaps back.
 */
export function SeekBar({
  position,
  duration,
  onSeek,
  onScrub,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  /** Throttled scrub position in seconds while the finger is down; null on lift. */
  onScrub?: (seconds: number | null) => void;
}) {
  const containerRef = useRef<View>(null);
  const [width, setWidth] = useState(0);
  const pageXRef = useRef(0);
  const widthRef = useRef(0);
  const fraction = useRef(new Animated.Value(0)).current;
  const scrubFractionRef = useRef(0);
  const lastEmitRef = useRef(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);

  // Follow playback while the finger is not down.
  useEffect(() => {
    if (scrubbing) return;
    const shown = seekTarget ?? position;
    fraction.setValue(duration > 0 ? Math.max(0, Math.min(1, shown / duration)) : 0);
  }, [position, duration, scrubbing, seekTarget, fraction]);

  useEffect(() => {
    if (seekTarget !== null && Math.abs(position - seekTarget) < 1.5) setSeekTarget(null);
  }, [position, seekTarget]);

  useEffect(() => {
    if (seekTarget === null) return;
    const timer = setTimeout(() => setSeekTarget(null), 2500);
    return () => clearTimeout(timer);
  }, [seekTarget]);

  const measure = () => {
    containerRef.current?.measureInWindow((x, _y, w) => {
      pageXRef.current = x;
      widthRef.current = w;
      setWidth(w);
    });
  };

  const fractionFromEvent = (e: GestureResponderEvent): number => {
    const w = widthRef.current;
    if (w <= 0) return 0;
    return Math.max(0, Math.min(1, (e.nativeEvent.pageX - pageXRef.current) / w));
  };

  const updateScrub = (e: GestureResponderEvent) => {
    const f = fractionFromEvent(e);
    scrubFractionRef.current = f;
    fraction.setValue(f);
    const now = Date.now();
    if (now - lastEmitRef.current >= 80) {
      lastEmitRef.current = now;
      onScrub?.(f * duration);
    }
  };

  const commitSeek = (f: number) => {
    setScrubbing(false);
    onScrub?.(null);
    if (duration > 0) {
      const seconds = f * duration;
      setSeekTarget(seconds);
      fraction.setValue(f);
      onSeek(seconds);
    }
  };

  const thumbSize = scrubbing ? THUMB_ACTIVE : THUMB;
  const translateX = fraction.interpolate({
    inputRange: [0, 1],
    outputRange: [-thumbSize / 2, Math.max(1, width) - thumbSize / 2],
  });

  return (
    <View
      ref={containerRef}
      style={styles.touchArea}
      onLayout={measure}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        setScrubbing(true);
        lastEmitRef.current = 0;
        updateScrub(e);
      }}
      onResponderMove={updateScrub}
      onResponderRelease={(e) => commitSeek(fractionFromEvent(e))}
      onResponderTerminate={() => {
        // A native gesture stole the touch mid-drag. Commit the last scrub
        // position instead of discarding it, so the bar never snaps back.
        commitSeek(scrubFractionRef.current);
      }}
    >
      <View style={[styles.track, scrubbing && styles.trackActive]}>
        <Animated.View
          style={[styles.fill, { transform: [{ scaleX: fraction }] }]}
        />
      </View>
      <Animated.View
        style={[
          styles.thumb,
          {
            width: thumbSize,
            height: thumbSize,
            borderRadius: thumbSize / 2,
            transform: [{ translateX }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  touchArea: {
    height: 44,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  trackActive: {
    height: 6,
    borderRadius: 3,
  },
  fill: {
    height: '100%',
    width: '100%',
    backgroundColor: colors.accent,
    transformOrigin: 'left',
  },
  thumb: {
    position: 'absolute',
    left: 0,
    backgroundColor: colors.text,
  },
});
