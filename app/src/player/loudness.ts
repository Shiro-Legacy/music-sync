/**
 * Volume leveling math. Pure — no React Native imports — so it is unit-tested.
 *
 * The server publishes each track's EBU R128 integrated loudness (LUFS). The player
 * cannot boost above unity, only attenuate, so every track is brought to a common
 * reference level that sits HEADROOM_DB below the target: loud tracks are turned
 * down, and tracks up to HEADROOM_DB quieter than the target are lifted (relative
 * to the others) to meet them. Turn the phone up ~4 dB compared to unleveled playback.
 */

/** Same target as the LocalMusic pipeline this replaces (EBU R128 loudnorm at -14 LUFS). */
export const TARGET_LUFS = -14;

/**
 * Attenuation applied to a track that sits exactly at the target. Chosen from a survey
 * of the real libraries (median -9 LUFS, 5th percentile -17 LUFS): 4 dB fully levels
 * ~97% of tracks; the few quieter than -18 LUFS stay a little quiet instead of clipping.
 */
export const HEADROOM_DB = 4;

/** Effective playback reference: every leveled track comes out at this loudness. */
export const REFERENCE_LUFS = TARGET_LUFS - HEADROOM_DB;

/** Gain in dB the player applies for a track of the given loudness (before clamping to unity). */
export function levelingGainDb(loudness: number | null): number {
  // Unmeasured tracks are assumed to sit at the target so they blend in rather than blast.
  const measured = loudness ?? TARGET_LUFS;
  return REFERENCE_LUFS - measured;
}

/** RNTP volume (0..1) for a track. `enabled: false` is plain unity playback. */
export function levelingVolume(loudness: number | null, enabled: boolean): number {
  if (!enabled) return 1;
  const linear = Math.pow(10, levelingGainDb(loudness) / 20);
  return Math.min(1, Math.max(0, linear));
}
