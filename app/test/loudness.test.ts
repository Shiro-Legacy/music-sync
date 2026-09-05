import { describe, expect, it } from 'vitest';

import {
  HEADROOM_DB,
  levelingGainDb,
  levelingVolume,
  REFERENCE_LUFS,
  TARGET_LUFS,
} from '../src/player/loudness';

describe('volume leveling math', () => {
  it('brings a track at the target down by exactly the headroom', () => {
    expect(levelingGainDb(TARGET_LUFS)).toBe(-HEADROOM_DB);
    expect(levelingVolume(TARGET_LUFS, true)).toBeCloseTo(Math.pow(10, -HEADROOM_DB / 20), 6);
  });

  it('attenuates loud tracks more and lifts quiet tracks up to the reference', () => {
    const loud = levelingVolume(-8, true);
    const target = levelingVolume(TARGET_LUFS, true);
    const quiet = levelingVolume(-17, true);
    expect(loud).toBeLessThan(target);
    expect(quiet).toBeGreaterThan(target);
    // -8 LUFS needs 10 dB down to reach -18: ratio between loud and target is 6 dB
    expect(20 * Math.log10(target / loud)).toBeCloseTo(6, 6);
  });

  it('never boosts above unity: tracks quieter than the reference stay at 1', () => {
    expect(levelingVolume(REFERENCE_LUFS, true)).toBeCloseTo(1, 9);
    expect(levelingVolume(-30, true)).toBe(1);
  });

  it('treats an unmeasured track as sitting at the target', () => {
    expect(levelingVolume(null, true)).toBe(levelingVolume(TARGET_LUFS, true));
  });

  it('is unity when leveling is disabled', () => {
    expect(levelingVolume(-6, false)).toBe(1);
    expect(levelingVolume(null, false)).toBe(1);
  });
});
