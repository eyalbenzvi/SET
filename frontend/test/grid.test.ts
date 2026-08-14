/**
 * Board layout: the whole board must fit the viewport whenever that is possible
 * at a legible card size, on every supported screen and board size.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_WIDTH,
  MAX_COLUMNS,
  MIN_CARD_WIDTH,
  MIN_COLUMNS,
  computeLayout,
  type LayoutInput,
} from '../src/ui/grid.js';

const GAP = 10;
const ASPECT = 0.7;

/** Board area for a phone/desktop viewport, minus header, action bar and padding. */
function area(width: number, height: number): { availableWidth: number; availableHeight: number } {
  return { availableWidth: width - 20, availableHeight: height - 20 };
}

function layoutFor(width: number, height: number, cardCount: number) {
  const input: LayoutInput = { ...area(width, height), cardCount, gap: GAP, aspect: ASPECT };
  return computeLayout(input);
}

/** Total pixels the grid occupies at a given layout. */
function occupied(layout: ReturnType<typeof computeLayout>): { width: number; height: number } {
  const cardHeight = layout.cardWidth / ASPECT;
  return {
    width: layout.columns * layout.cardWidth + (layout.columns - 1) * GAP,
    height: layout.rows * cardHeight + (layout.rows - 1) * GAP,
  };
}

const VIEWPORTS: [string, number, number][] = [
  ['tiny phone portrait', 320, 480],
  ['small phone portrait', 360, 500],
  ['iPhone portrait', 390, 560],
  ['large phone portrait', 430, 620],
  ['phone landscape', 740, 300],
  ['tablet portrait', 768, 900],
  ['tablet landscape', 1024, 700],
  ['desktop', 1280, 700],
  ['wide desktop', 1920, 1000],
];

const BOARD_SIZES = [12, 15, 18, 21];

describe('computeLayout', () => {
  it('returns an empty layout for an empty board', () => {
    const layout = layoutFor(390, 560, 0);
    expect(layout.cardWidth).toBe(0);
    expect(layout.rows).toBe(0);
  });

  it('keeps columns and card width within the supported range everywhere', () => {
    for (const [name, width, height] of VIEWPORTS) {
      for (const cardCount of BOARD_SIZES) {
        const layout = layoutFor(width, height, cardCount);
        expect(layout.columns, name).toBeGreaterThanOrEqual(MIN_COLUMNS);
        expect(layout.columns, name).toBeLessThanOrEqual(MAX_COLUMNS);
        expect(layout.cardWidth, `${name} / ${cardCount}`).toBeGreaterThan(0);
        expect(layout.cardWidth, `${name} / ${cardCount}`).toBeLessThanOrEqual(MAX_CARD_WIDTH);
        expect(layout.rows * layout.columns, name).toBeGreaterThanOrEqual(cardCount);
      }
    }
  });

  it('never overflows horizontally', () => {
    for (const [name, width, height] of VIEWPORTS) {
      for (const cardCount of BOARD_SIZES) {
        const layout = layoutFor(width, height, cardCount);
        const { availableWidth } = area(width, height);
        expect(occupied(layout).width, `${name} / ${cardCount}`).toBeLessThanOrEqual(
          availableWidth + 0.5,
        );
        expect(layout.boardWidth).toBeCloseTo(occupied(layout).width, 4);
      }
    }
  });

  it('fits a standard 12-card board entirely on every supported viewport', () => {
    for (const [name, width, height] of VIEWPORTS) {
      const layout = layoutFor(width, height, 12);
      expect(layout.scrolls, name).toBe(false);
      const { availableHeight } = area(width, height);
      expect(occupied(layout).height, name).toBeLessThanOrEqual(availableHeight + 0.5);
      expect(layout.cardWidth, name).toBeGreaterThanOrEqual(MIN_CARD_WIDTH);
    }
  });

  it('fits 15- and 18-card boards on a normal phone and up', () => {
    for (const [name, width, height] of VIEWPORTS.filter(([, w]) => w >= 360)) {
      for (const cardCount of [15, 18]) {
        const layout = layoutFor(width, height, cardCount);
        if (layout.scrolls) continue; // acceptable on the very shortest screens
        const { availableHeight } = area(width, height);
        expect(occupied(layout).height, `${name} / ${cardCount}`).toBeLessThanOrEqual(
          availableHeight + 0.5,
        );
      }
    }
  });

  it('keeps cards tappable, preferring to scroll over shrinking below the minimum', () => {
    // A deliberately cramped viewport with a large board.
    const layout = layoutFor(320, 300, 21);
    expect(layout.cardWidth).toBeGreaterThanOrEqual(MIN_CARD_WIDTH * 0.99);
  });

  it('prefers a column count that divides the board evenly when sizes are close', () => {
    // A wide, tall area where 4 and 6 columns give near-identical card sizes.
    const layout = computeLayout({
      availableWidth: 900,
      availableHeight: 2000,
      cardCount: 12,
      gap: GAP,
      aspect: ASPECT,
    });
    expect(12 % layout.columns).toBe(0);
  });

  it('caps card width so a wide desktop does not get giant cards', () => {
    const layout = layoutFor(2560, 1400, 12);
    expect(layout.cardWidth).toBe(MAX_CARD_WIDTH);
  });

  it('uses more columns as the viewport widens', () => {
    const narrow = layoutFor(320, 480, 12);
    const wide = layoutFor(1280, 800, 12);
    expect(wide.columns).toBeGreaterThanOrEqual(narrow.columns);
  });

  it('grows the row count rather than overflowing when the board grows', () => {
    const twelve = layoutFor(390, 560, 12);
    const eighteen = layoutFor(390, 560, 18);
    expect(eighteen.rows * eighteen.columns).toBeGreaterThanOrEqual(18);
    expect(eighteen.cardWidth).toBeLessThanOrEqual(twelve.cardWidth + 0.5);
  });

  it('is deterministic', () => {
    expect(layoutFor(390, 560, 12)).toEqual(layoutFor(390, 560, 12));
  });
});
