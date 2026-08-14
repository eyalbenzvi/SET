/**
 * Board layout maths — pure functions, no DOM.
 *
 * The goal is simple and it matters a lot on a phone: **every face-up card
 * should be visible at once, as large as possible.** Scanning a SET board means
 * seeing the whole board, so having to scroll to find cards is a gameplay
 * problem, not a cosmetic one.
 *
 * So rather than picking a column count from breakpoints and hoping it fits, we
 * try every sensible column count, work out how large a card could be in each,
 * and keep the best. A layout whose columns divide the board evenly gets a small
 * bonus, because a ragged final row looks unfinished.
 *
 * A consequence worth stating: on a narrow portrait phone a 12-card board
 * usually lands on four columns rather than three, because four columns fit
 * entirely on screen *and* yield slightly larger cards than three columns would.
 */

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 6;
/** Below this, cards stop being comfortable touch targets. */
export const MIN_CARD_WIDTH = 62;
/** Above this, cards look oversized on a wide desktop window. */
export const MAX_CARD_WIDTH = 190;
/** How much smaller an evenly-dividing layout may be and still win. */
const RAGGED_PENALTY = 0.94;

export interface LayoutInput {
  /** Space available for the grid in CSS pixels, excluding padding. */
  availableWidth: number;
  availableHeight: number;
  cardCount: number;
  /** Gap between cards, on both axes. */
  gap: number;
  /** Card width divided by card height; portrait cards are below 1. */
  aspect: number;
}

export interface Layout {
  columns: number;
  rows: number;
  cardWidth: number;
  /** Total grid width, so wrapping happens exactly at `columns`. */
  boardWidth: number;
  /** True when the board still needs vertical scrolling at this size. */
  scrolls: boolean;
}

function sizeFor(input: LayoutInput, columns: number): { width: number; rows: number } {
  const rows = Math.ceil(input.cardCount / columns);
  const fromWidth = (input.availableWidth - (columns - 1) * input.gap) / columns;
  const fromHeight = ((input.availableHeight - (rows - 1) * input.gap) / rows) * input.aspect;
  return { width: Math.min(fromWidth, fromHeight), rows };
}

function build(input: LayoutInput, columns: number, width: number, scrolls: boolean): Layout {
  const cardWidth = Math.max(Math.min(width, MAX_CARD_WIDTH), 1);
  const rows = Math.ceil(input.cardCount / columns);
  return {
    columns,
    rows,
    cardWidth,
    boardWidth: columns * cardWidth + (columns - 1) * input.gap,
    scrolls,
  };
}

/**
 * Choose the column count and card size for a board.
 *
 * Always returns a usable size. When the viewport genuinely cannot hold the
 * whole board at a legible card size, it picks the most columns that still keep
 * cards tappable and reports `scrolls` so the board region scrolls instead of
 * squashing cards into illegibility.
 */
export function computeLayout(input: LayoutInput): Layout {
  if (input.cardCount <= 0) {
    return { columns: MIN_COLUMNS, rows: 0, cardWidth: 0, boardWidth: 0, scrolls: false };
  }

  let best: Layout | null = null;
  let bestScore = 0;
  for (let columns = MIN_COLUMNS; columns <= Math.min(MAX_COLUMNS, input.cardCount); columns++) {
    const { width } = sizeFor(input, columns);
    if (width < MIN_CARD_WIDTH) continue;
    const candidate = build(input, columns, width, false);
    const ragged = input.cardCount % columns !== 0;
    const score = candidate.cardWidth * (ragged ? RAGGED_PENALTY : 1);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best) return best;

  // Nothing fits both axes at a usable size. Prefer the *most* columns that keep
  // cards tappable, so the amount of scrolling stays as small as possible.
  for (let columns = Math.min(MAX_COLUMNS, input.cardCount); columns >= MIN_COLUMNS; columns--) {
    const width = (input.availableWidth - (columns - 1) * input.gap) / columns;
    if (width >= MIN_CARD_WIDTH) return build(input, columns, width, true);
  }
  const columns = Math.min(MAX_COLUMNS, Math.max(input.cardCount, MIN_COLUMNS));
  const width = (input.availableWidth - (columns - 1) * input.gap) / columns;
  return build(input, columns, width, true);
}
