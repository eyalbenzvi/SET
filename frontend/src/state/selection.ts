/**
 * Card selection rules — pure functions, no DOM.
 *
 * Product decision: selecting a fourth card is *prevented* with a short prompt
 * rather than silently replacing the oldest selection. Replacing would make a
 * mis-tap change a card the player thought was locked in, which is worse on a
 * phone than being told to unpick one.
 */

import { SET_SIZE, type CardId } from '@set/shared';

export interface SelectionChange {
  selection: CardId[];
  /** True when the tap was refused because three cards are already selected. */
  blocked: boolean;
}

/** Toggle `cardId`, keeping at most three cards and ignoring cards not on the board. */
export function toggleSelection(
  selection: readonly CardId[],
  cardId: CardId,
  board: readonly CardId[],
): SelectionChange {
  if (!board.includes(cardId)) return { selection: [...selection], blocked: false };
  if (selection.includes(cardId)) {
    return { selection: selection.filter((id) => id !== cardId), blocked: false };
  }
  if (selection.length >= SET_SIZE) return { selection: [...selection], blocked: true };
  return { selection: [...selection, cardId], blocked: false };
}

/** Drop any selected card that is no longer on the board. */
export function pruneSelection(selection: readonly CardId[], board: readonly CardId[]): CardId[] {
  return selection.filter((id) => board.includes(id));
}

export function isClaimable(selection: readonly CardId[]): boolean {
  return selection.length === SET_SIZE;
}

/** 1-based position of a card in the selection, or 0 when unselected. */
export function selectionIndex(selection: readonly CardId[], cardId: CardId): number {
  return selection.indexOf(cardId) + 1;
}
