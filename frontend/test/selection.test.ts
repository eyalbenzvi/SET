/**
 * Selection rules and claim-control enablement.
 */

import { describe, expect, it } from 'vitest';
import {
  isClaimable,
  pruneSelection,
  selectionIndex,
  toggleSelection,
} from '../src/state/selection.js';

const BOARD = [10, 20, 30, 40, 50, 60, 70, 80, 1, 2, 3, 4];

describe('toggleSelection', () => {
  it('adds a card that is on the board', () => {
    expect(toggleSelection([], 20, BOARD)).toEqual({ selection: [20], blocked: false });
  });

  it('keeps tap order, which drives the position badges', () => {
    let selection: number[] = [];
    for (const id of [30, 10, 20]) {
      selection = toggleSelection(selection, id, BOARD).selection;
    }
    expect(selection).toEqual([30, 10, 20]);
    expect(selectionIndex(selection, 30)).toBe(1);
    expect(selectionIndex(selection, 10)).toBe(2);
    expect(selectionIndex(selection, 20)).toBe(3);
    expect(selectionIndex(selection, 40)).toBe(0);
  });

  it('removes a card that is already selected', () => {
    expect(toggleSelection([10, 20], 10, BOARD)).toEqual({ selection: [20], blocked: false });
  });

  it('refuses a fourth card and reports it as blocked', () => {
    const result = toggleSelection([10, 20, 30], 40, BOARD);
    expect(result).toEqual({ selection: [10, 20, 30], blocked: true });
  });

  it('still allows deselecting while three are selected', () => {
    const result = toggleSelection([10, 20, 30], 20, BOARD);
    expect(result).toEqual({ selection: [10, 30], blocked: false });
  });

  it('ignores cards that are not on the board', () => {
    expect(toggleSelection([10], 99, BOARD)).toEqual({ selection: [10], blocked: false });
  });

  it('never mutates the input array', () => {
    const selection = [10, 20];
    toggleSelection(selection, 30, BOARD);
    expect(selection).toEqual([10, 20]);
  });
});

describe('pruneSelection', () => {
  it('drops selected cards that have left the board', () => {
    expect(pruneSelection([10, 20, 30], [10, 30, 99])).toEqual([10, 30]);
  });

  it('keeps everything when the board still holds all of them', () => {
    expect(pruneSelection([10, 20], BOARD)).toEqual([10, 20]);
  });

  it('empties the selection when the whole board changed', () => {
    expect(pruneSelection([10, 20, 30], [1, 2, 3])).toEqual([]);
  });
});

describe('isClaimable', () => {
  it('is true only at exactly three cards', () => {
    expect(isClaimable([])).toBe(false);
    expect(isClaimable([1])).toBe(false);
    expect(isClaimable([1, 2])).toBe(false);
    expect(isClaimable([1, 2, 3])).toBe(true);
  });
});
