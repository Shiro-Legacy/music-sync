import { describe, expect, it } from 'vitest';

import { artSideFor } from '../src/ui/playerLayout';

// Estimated vertical budget, not a native layout test. Device acceptance must
// still check real font metrics, safe areas, and transport hit targets.
const SCREEN_H = 667; // iPhone SE 2nd/3rd gen
const CONTENT_W = 375 - 48; // container paddingHorizontal 24 each side
const TOP = 32; // topInset 20 + 12
const BOTTOM = 24; // bottomInset 0 + 24
const DISMISS = 22 + 8; // chevron 22 + marginBottom 8
const STAGE_MARGIN = 12;
const PLAY = 76; // transport row height = play button
const MARGINS = { full: 28 + 24 + 28, compact: 12 * 3 }; // meta, seek, controls
const LINE_FACTOR = 1.3;
const compact = (screenH: number, fontScale: number) => screenH <= 700 || fontScale >= 1.5;
const line = (font: number, scale: number) => Math.ceil(font * LINE_FACTOR * scale);

const fixedBlocks = (scale: number, screenH = SCREEN_H) =>
  TOP +
  BOTTOM +
  DISMISS +
  (compact(screenH, scale) ? MARGINS.compact : MARGINS.full) +
  6 + // meta gap
  line(22, scale) * 2 + // title, numberOfLines 2
  line(16, scale) + // artist
  44 + // seek touch area
  line(12, scale) + // times row
  PLAY;

describe('full player on iPhone SE (375×667)', () => {
  it.each([1, 1.5, 3.1])('keeps the transport on screen at %s× font scale', (scale) => {
    const stage = SCREEN_H - fixedBlocks(scale) - STAGE_MARGIN;
    const side = artSideFor(CONTENT_W, stage);
    expect(side).toBeGreaterThan(0);
    expect(side).toBeLessThanOrEqual(stage); // art never overflows its leftover
    // Whole column (fixed blocks + stage margin + art) must fit the screen.
    expect(fixedBlocks(scale) + STAGE_MARGIN + side).toBeLessThanOrEqual(SCREEN_H);
  });

  it('uses compact spacing for short screens and enlarged text', () => {
    expect(compact(667, 1)).toBe(true);
    expect(compact(844, 3.1)).toBe(true);
    expect(compact(844, 1)).toBe(false);
  });

  it('width-sized square art (the old layout) overflows 667pt', () => {
    // Before the fix the art was CONTENT_W wide with aspectRatio 1 and no
    // vertical cap that binds on SE: fixed blocks + 327pt square pushed the
    // transport below the screen. Guard the regression stays dead.
    expect(fixedBlocks(1) + STAGE_MARGIN + CONTENT_W).toBeGreaterThan(SCREEN_H);
    expect(artSideFor(400, 500)).toBe(360); // internal cap binds on tall/wide stages
    expect(artSideFor(CONTENT_W, 320)).toBe(320); // leftover binds before width does
    expect(artSideFor(CONTENT_W, 0)).toBe(0); // zero leftover → no art
  });
});
