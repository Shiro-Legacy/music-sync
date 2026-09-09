/**
 * Full-player artwork sizing. The screen column is fixed blocks (dismiss,
 * meta, seek bar, transport, insets) plus one flexible art stage between
 * dismiss and meta; the square artwork must fit that leftover or it pushes
 * the transport off-screen on short devices (iPhone SE, 667pt).
 */
const ART_MAX_SIDE = 360;

export function artSideFor(stageWidth: number, stageHeight: number): number {
  return Math.max(0, Math.min(stageWidth, stageHeight, ART_MAX_SIDE));
}
