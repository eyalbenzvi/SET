/**
 * The pure SET rules engine — the single source of truth for game legality.
 *
 * A valid SET is exactly three distinct cards where, for EACH of the four
 * attributes independently, either all three values are equal or all three
 * values are different. Equivalently, because each attribute has exactly three
 * values encoded as `0 | 1 | 2`:
 *
 *     (a + b + c) % 3 === 0
 *
 * ...holds if and only if the three values are all-same or all-different. That
 * identity is what makes `findRequiredThirdCard` exact and total.
 *
 * This module has no dependencies beyond `cards.ts` and is exhaustively tested.
 */

import {
  ATTRIBUTES,
  ATTRIBUTE_VALUE_NAMES,
  DECK,
  SET_SIZE,
  cardById,
  makeCard,
  type Attribute,
  type AttrValue,
  type Card,
  type CardId,
} from './cards.js';

/** True when three attribute values are all the same or all different. */
export function isValidTriple(a: AttrValue, b: AttrValue, c: AttrValue): boolean {
  return (a + b + c) % 3 === 0;
}

/**
 * True when the three cards form a valid SET.
 *
 * The three cards must be distinct; passing the same card twice is never a SET
 * (it would also be impossible on a real board, where every card is unique).
 */
export function isSet(a: Card, b: Card, c: Card): boolean {
  if (a.id === b.id || b.id === c.id || a.id === c.id) return false;
  return (
    isValidTriple(a.count, b.count, c.count) &&
    isValidTriple(a.shape, b.shape, c.shape) &&
    isValidTriple(a.color, b.color, c.color) &&
    isValidTriple(a.fill, b.fill, c.fill)
  );
}

/** `isSet` over card ids. */
export function isSetByIds(a: CardId, b: CardId, c: CardId): boolean {
  return isSet(cardById(a), cardById(b), cardById(c));
}

/**
 * The unique third value that completes a valid triple given the first two.
 *
 * If the first two values are equal the answer is that same value; otherwise it
 * is the single remaining value. `(-(a + b)) mod 3` yields both cases.
 */
export function requiredThirdValue(a: AttrValue, b: AttrValue): AttrValue {
  return ((6 - a - b) % 3) as AttrValue;
}

/**
 * The one card that completes a valid SET with `a` and `b`.
 *
 * For any two distinct cards this card always exists, is unique, and differs
 * from both inputs — the deck contains every attribute combination.
 */
export function findRequiredThirdCard(a: Card, b: Card): Card {
  return makeCard(
    requiredThirdValue(a.count, b.count),
    requiredThirdValue(a.shape, b.shape),
    requiredThirdValue(a.color, b.color),
    requiredThirdValue(a.fill, b.fill),
  );
}

/** `findRequiredThirdCard` over card ids. */
export function findRequiredThirdCardId(a: CardId, b: CardId): CardId {
  return findRequiredThirdCard(cardById(a), cardById(b)).id;
}

/** A triple of card ids, ordered as they appear in the source collection. */
export type SetTriple = readonly [CardId, CardId, CardId];

/**
 * Every valid SET contained in `cards`, without duplicates.
 *
 * Each result is reported once with its members in ascending index order, so
 * the same three cards can never appear twice under different permutations.
 */
export function findAllSets(cards: readonly Card[]): SetTriple[] {
  const found: SetTriple[] = [];
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i]!;
    for (let j = i + 1; j < cards.length; j++) {
      const b = cards[j]!;
      for (let k = j + 1; k < cards.length; k++) {
        const c = cards[k]!;
        if (isSet(a, b, c)) found.push([a.id, b.id, c.id]);
      }
    }
  }
  return found;
}

/** `findAllSets` over card ids. */
export function findAllSetsByIds(ids: readonly CardId[]): SetTriple[] {
  return findAllSets(ids.map(cardById));
}

/**
 * Whether at least one valid SET exists among `ids`.
 *
 * Short-circuits on the first hit; used on every board mutation, so it avoids
 * building the full list.
 */
export function hasSet(ids: readonly CardId[]): boolean {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const needed = findRequiredThirdCardId(ids[i]!, ids[j]!);
      for (let k = j + 1; k < ids.length; k++) {
        if (ids[k] === needed) return true;
      }
    }
  }
  return false;
}

/**
 * The first valid SET among `ids`, in board order, or `null`.
 *
 * The server calls this in exactly one place: answering a hint request, where it
 * reveals the first one or two of these cards to the player who asked. Nothing
 * else ever tells a client where a set is.
 */
export function findFirstSet(ids: readonly CardId[]): SetTriple | null {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const needed = findRequiredThirdCardId(ids[i]!, ids[j]!);
      for (let k = j + 1; k < ids.length; k++) {
        if (ids[k] === needed) return [ids[i]!, ids[j]!, ids[k]!];
      }
    }
  }
  return null;
}

/**
 * Why a triple is not a SET: the attributes on which exactly two of the three
 * values match. Empty when the triple *is* a valid SET.
 *
 * Used to explain a rejected claim to the player ("two cards are purple and one
 * is green") without ever revealing a real set.
 */
export function explainNotASet(a: Card, b: Card, c: Card): Attribute[] {
  const failing: Attribute[] = [];
  for (const attribute of ATTRIBUTES) {
    if (!isValidTriple(a[attribute], b[attribute], c[attribute])) failing.push(attribute);
  }
  return failing;
}

/** A single "two the same, one different" mismatch, ready for display. */
export interface AttributeMismatch {
  attribute: Attribute;
  /** The value shared by two of the three cards, e.g. `purple`. */
  repeatedValue: string;
  /** The value held by the odd card out, e.g. `green`. */
  oddValue: string;
}

/**
 * A displayable description of the first failing attribute of a rejected
 * triple, or `null` when the triple is a valid SET.
 */
export function describeMismatch(a: Card, b: Card, c: Card): AttributeMismatch | null {
  for (const attribute of ATTRIBUTES) {
    const values: AttrValue[] = [a[attribute], b[attribute], c[attribute]];
    if (isValidTriple(values[0]!, values[1]!, values[2]!)) continue;
    // Exactly two values match; find which value repeats and which is the odd one.
    const [x, y, z] = values as [AttrValue, AttrValue, AttrValue];
    const repeated = x === y ? x : x === z ? x : y;
    const odd = x === y ? z : x === z ? y : x;
    const names = ATTRIBUTE_VALUE_NAMES[attribute];
    return { attribute, repeatedValue: names[repeated], oddValue: names[odd] };
  }
  return null;
}

/** `describeMismatch` over card ids. */
export function describeMismatchByIds(ids: SetTriple): AttributeMismatch | null {
  return describeMismatch(cardById(ids[0]), cardById(ids[1]), cardById(ids[2]));
}

/** Total number of distinct SETs in a full 81-card deck: 81 * 80 / 6 = 1080. */
export const TOTAL_SETS_IN_DECK = (DECK.length * (DECK.length - 1)) / SET_SIZE / 2;
