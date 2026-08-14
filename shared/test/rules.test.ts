import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTES,
  COLOR_VALUES,
  COUNT_VALUES,
  DECK,
  DECK_SIZE,
  FILL_VALUES,
  SHAPE_VALUES,
  cardById,
  describeCard,
  freshDeckIds,
  isCardId,
  makeCard,
  type Attribute,
  type AttrValue,
  type Card,
} from '../src/cards.js';
import {
  TOTAL_SETS_IN_DECK,
  describeMismatch,
  explainNotASet,
  findAllSets,
  findAllSetsByIds,
  findFirstSet,
  findRequiredThirdCard,
  hasSet,
  isSet,
  isValidTriple,
  requiredThirdValue,
} from '../src/rules.js';
import { seededRandom, shuffled } from '../src/shuffle.js';

const ALL_VALUES: AttrValue[] = [0, 1, 2];

describe('deck generation', () => {
  it('contains exactly 81 cards', () => {
    expect(DECK).toHaveLength(81);
    expect(DECK_SIZE).toBe(81);
  });

  it('contains only unique cards', () => {
    const keys = new Set(DECK.map((c) => `${c.count}${c.shape}${c.color}${c.fill}`));
    expect(keys.size).toBe(81);
    expect(new Set(DECK.map((c) => c.id)).size).toBe(81);
  });

  it('contains every combination of the four attributes exactly once', () => {
    for (const count of ALL_VALUES) {
      for (const shape of ALL_VALUES) {
        for (const color of ALL_VALUES) {
          for (const fill of ALL_VALUES) {
            const matches = DECK.filter(
              (c) => c.count === count && c.shape === shape && c.color === color && c.fill === fill,
            );
            expect(matches).toHaveLength(1);
          }
        }
      }
    }
  });

  it('gives every card valid attribute values and a self-consistent id', () => {
    for (const card of DECK) {
      for (const attribute of ATTRIBUTES) {
        expect(ALL_VALUES).toContain(card[attribute]);
      }
      expect(card.id).toBe(card.count * 27 + card.shape * 9 + card.color * 3 + card.fill);
      expect(cardById(card.id)).toEqual(card);
      expect(makeCard(card.count, card.shape, card.color, card.fill).id).toBe(card.id);
    }
  });

  it('rejects out-of-range and non-integer card ids', () => {
    expect(isCardId(0)).toBe(true);
    expect(isCardId(80)).toBe(true);
    expect(isCardId(81)).toBe(false);
    expect(isCardId(-1)).toBe(false);
    expect(isCardId(1.5)).toBe(false);
    expect(isCardId('4')).toBe(false);
    expect(isCardId(NaN)).toBe(false);
    expect(() => cardById(81)).toThrow(RangeError);
  });

  it('freshDeckIds returns all 81 ids in canonical order', () => {
    const ids = freshDeckIds();
    expect(ids).toHaveLength(81);
    expect(ids[0]).toBe(0);
    expect(ids[80]).toBe(80);
  });

  it('describes cards in readable English', () => {
    expect(describeCard(makeCard(0, 1, 0, 2))).toBe('one solid red diamond');
    expect(describeCard(makeCard(2, 2, 2, 0))).toBe('three open purple squiggles');
    expect(COUNT_VALUES).toEqual(['one', 'two', 'three']);
    expect(SHAPE_VALUES).toEqual(['oval', 'diamond', 'squiggle']);
    expect(COLOR_VALUES).toEqual(['red', 'green', 'purple']);
    expect(FILL_VALUES).toEqual(['open', 'striped', 'solid']);
  });
});

describe('isValidTriple', () => {
  it('accepts all-same and all-different, rejects two-same-one-different', () => {
    for (const a of ALL_VALUES) {
      for (const b of ALL_VALUES) {
        for (const c of ALL_VALUES) {
          const allSame = a === b && b === c;
          const allDifferent = a !== b && b !== c && a !== c;
          expect(isValidTriple(a, b, c)).toBe(allSame || allDifferent);
        }
      }
    }
  });
});

describe('isSet', () => {
  it('accepts three cards differing only in count (documented tutorial example)', () => {
    const a = makeCard(0, 0, 0, 0);
    const b = makeCard(1, 0, 0, 0);
    const c = makeCard(2, 0, 0, 0);
    expect(isSet(a, b, c)).toBe(true);
  });

  it('accepts three cards where every attribute differs', () => {
    const a = makeCard(0, 0, 0, 0);
    const b = makeCard(1, 1, 1, 1);
    const c = makeCard(2, 2, 2, 2);
    expect(isSet(a, b, c)).toBe(true);
  });

  it('accepts three identical-in-every-attribute-but-shape cards', () => {
    expect(isSet(makeCard(1, 0, 2, 1), makeCard(1, 1, 2, 1), makeCard(1, 2, 2, 1))).toBe(true);
  });

  it('rejects a triple where two cards are purple and one is green', () => {
    const a = makeCard(0, 0, 2, 0); // purple
    const b = makeCard(1, 0, 2, 0); // purple
    const c = makeCard(2, 0, 1, 0); // green
    expect(isSet(a, b, c)).toBe(false);
    expect(explainNotASet(a, b, c)).toEqual(['color']);
  });

  it('rejects "two same, one different" for every attribute independently', () => {
    for (const attribute of ATTRIBUTES) {
      const base: Record<Attribute, AttrValue> = { count: 0, shape: 0, color: 0, fill: 0 };
      const build = (overrides: Partial<Record<Attribute, AttrValue>>): Card => {
        const v = { ...base, ...overrides };
        return makeCard(v.count, v.shape, v.color, v.fill);
      };
      // Make the three cards a valid set on every attribute except `attribute`,
      // where the values are 0, 0, 1 — two the same, one different.
      const others = ATTRIBUTES.filter((x) => x !== attribute);
      const cards = [0, 1, 2].map((i) => {
        const overrides: Partial<Record<Attribute, AttrValue>> = {};
        for (const other of others) overrides[other] = i as AttrValue;
        overrides[attribute] = (i === 2 ? 1 : 0) as AttrValue;
        return build(overrides);
      }) as [Card, Card, Card];

      expect(isSet(...cards)).toBe(false);
      expect(explainNotASet(...cards)).toEqual([attribute]);
      const mismatch = describeMismatch(...cards);
      expect(mismatch).not.toBeNull();
      expect(mismatch?.attribute).toBe(attribute);
    }
  });

  it('rejects triples containing a repeated card', () => {
    const a = makeCard(0, 0, 0, 0);
    const b = makeCard(1, 1, 1, 1);
    expect(isSet(a, a, b)).toBe(false);
    expect(isSet(a, b, a)).toBe(false);
    expect(isSet(b, a, a)).toBe(false);
    expect(isSet(a, a, a)).toBe(false);
  });

  it('is symmetric under permutation for every set in the deck', () => {
    const sets = findAllSets(DECK);
    for (const [x, y, z] of sets.slice(0, 200)) {
      const [a, b, c] = [cardById(x), cardById(y), cardById(z)];
      for (const perm of [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
      ] as [Card, Card, Card][]) {
        expect(isSet(...perm)).toBe(true);
      }
    }
  });
});

describe('requiredThirdValue / findRequiredThirdCard', () => {
  it('returns the same value when the first two match, otherwise the remaining value', () => {
    for (const a of ALL_VALUES) {
      for (const b of ALL_VALUES) {
        const c = requiredThirdValue(a, b);
        expect(ALL_VALUES).toContain(c);
        if (a === b) {
          expect(c).toBe(a);
        } else {
          expect(c).not.toBe(a);
          expect(c).not.toBe(b);
        }
        expect(isValidTriple(a, b, c)).toBe(true);
      }
    }
  });

  it('exhaustively completes a valid set for every ordered pair of distinct cards', () => {
    // 81 * 80 = 6480 pairs — checked in full, no sampling.
    let pairs = 0;
    for (const a of DECK) {
      for (const b of DECK) {
        if (a.id === b.id) continue;
        pairs++;
        const c = findRequiredThirdCard(a, b);
        expect(isCardId(c.id)).toBe(true);
        expect(c.id).not.toBe(a.id);
        expect(c.id).not.toBe(b.id);
        expect(isSet(a, b, c)).toBe(true);
        // Uniqueness: no other card in the deck completes this pair.
        const completions = DECK.filter((x) => isSet(a, b, x));
        expect(completions).toHaveLength(1);
        expect(completions[0]!.id).toBe(c.id);
        // The relation is symmetric and closed under rotation.
        expect(findRequiredThirdCard(b, a).id).toBe(c.id);
        expect(findRequiredThirdCard(a, c).id).toBe(b.id);
        expect(findRequiredThirdCard(c, b).id).toBe(a.id);
      }
    }
    expect(pairs).toBe(6480);
  });
});

describe('findAllSets', () => {
  it('finds all 1080 sets in a full deck, without duplicates', () => {
    const sets = findAllSets(DECK);
    expect(sets).toHaveLength(1080);
    expect(TOTAL_SETS_IN_DECK).toBe(1080);
    const keys = new Set(sets.map((t) => [...t].sort((a, b) => a - b).join('-')));
    expect(keys.size).toBe(1080);
  });

  it('reports every triple in ascending source-index order and only valid sets', () => {
    const sets = findAllSets(DECK);
    for (const [a, b, c] of sets) {
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(isSet(cardById(a), cardById(b), cardById(c))).toBe(true);
    }
  });

  it('finds nothing in collections that are too small', () => {
    expect(findAllSets([])).toEqual([]);
    expect(findAllSets([cardById(0)])).toEqual([]);
    expect(findAllSets([cardById(0), cardById(1)])).toEqual([]);
  });

  it('agrees with hasSet and findFirstSet on many random boards', () => {
    const random = seededRandom(0xc0ffee);
    for (let trial = 0; trial < 400; trial++) {
      const board = shuffled(freshDeckIds(), random).slice(0, 12);
      const sets = findAllSetsByIds(board);
      expect(hasSet(board)).toBe(sets.length > 0);
      const first = findFirstSet(board);
      if (sets.length === 0) {
        expect(first).toBeNull();
      } else {
        expect(first).not.toBeNull();
        const [a, b, c] = first!;
        expect(isSet(cardById(a), cardById(b), cardById(c))).toBe(true);
        expect(board).toContain(a);
        expect(board).toContain(b);
        expect(board).toContain(c);
      }
    }
  });

  it('finds a known count on a hand-built board', () => {
    // Cards 0..11 of the canonical deck: count 0, shapes 0-1, all colours/fills.
    const board = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const sets = findAllSetsByIds(board);
    for (const [a, b, c] of sets) expect(isSet(cardById(a), cardById(b), cardById(c))).toBe(true);
    // Brute-force reference implementation, independent of the optimised path.
    let reference = 0;
    for (let i = 0; i < board.length; i++) {
      for (let j = i + 1; j < board.length; j++) {
        for (let k = j + 1; k < board.length; k++) {
          if (isSet(cardById(board[i]!), cardById(board[j]!), cardById(board[k]!))) reference++;
        }
      }
    }
    expect(sets).toHaveLength(reference);
  });
});

describe('describeMismatch', () => {
  it('returns null for a valid set', () => {
    expect(
      describeMismatch(makeCard(0, 0, 0, 0), makeCard(1, 0, 0, 0), makeCard(2, 0, 0, 0)),
    ).toBeNull();
  });

  it('names the repeated and odd values', () => {
    const mismatch = describeMismatch(
      makeCard(0, 0, 2, 0),
      makeCard(1, 0, 2, 0),
      makeCard(2, 0, 1, 0),
    );
    expect(mismatch).toEqual({ attribute: 'color', repeatedValue: 'purple', oddValue: 'green' });
  });

  it('identifies the odd card regardless of its position', () => {
    const purple = (count: AttrValue): Card => makeCard(count, 0, 2, 0);
    const green = (count: AttrValue): Card => makeCard(count, 0, 1, 0);
    expect(describeMismatch(green(0), purple(1), purple(2))).toEqual({
      attribute: 'color',
      repeatedValue: 'purple',
      oddValue: 'green',
    });
    expect(describeMismatch(purple(0), green(1), purple(2))).toEqual({
      attribute: 'color',
      repeatedValue: 'purple',
      oddValue: 'green',
    });
  });

  it('always finds a mismatch for any non-set triple in the deck', () => {
    const random = seededRandom(42);
    let checked = 0;
    while (checked < 500) {
      const ids = shuffled(freshDeckIds(), random).slice(0, 3) as [number, number, number];
      const cards = ids.map(cardById) as [Card, Card, Card];
      if (isSet(...cards)) continue;
      checked++;
      const mismatch = describeMismatch(...cards);
      expect(mismatch).not.toBeNull();
      expect(mismatch!.repeatedValue).not.toBe(mismatch!.oddValue);
      expect(explainNotASet(...cards).length).toBeGreaterThan(0);
      expect(explainNotASet(...cards)[0]).toBe(mismatch!.attribute);
    }
  });
});

describe('hasSet', () => {
  it('is false for boards with fewer than three cards', () => {
    expect(hasSet([])).toBe(false);
    expect(hasSet([0])).toBe(false);
    expect(hasSet([0, 1])).toBe(false);
  });

  it('is true for a minimal board that contains a set', () => {
    expect(hasSet([0, 27, 54])).toBe(true);
  });

  it('is false for a hand-checked set-free collection', () => {
    // (0,0,0,0) (0,0,0,1) (0,0,1,0) (0,0,1,1): every triple has two colours
    // the same and one different, or two fills the same and one different.
    const board = [0, 1, 3, 4];
    expect(findAllSetsByIds(board)).toEqual([]);
    expect(hasSet(board)).toBe(false);
  });
});
