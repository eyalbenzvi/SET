/**
 * Card model for the game of SET.
 *
 * Every card is a unique combination of four attributes, each having exactly
 * three possible values. Internally every attribute value is represented as
 * `0 | 1 | 2` so that the "all same or all different" rule reduces to simple
 * modular arithmetic (see `rules.ts`).
 *
 * This module is pure: no UI, no network, no platform APIs.
 */

/** One of the three possible values an attribute can take. */
export type AttrValue = 0 | 1 | 2;

/** The four independent attributes of a card, in canonical order. */
export const ATTRIBUTES = ['count', 'shape', 'color', 'fill'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/** Number of symbols printed on the card. */
export const COUNT_VALUES = ['one', 'two', 'three'] as const;
/** Symbol outline. */
export const SHAPE_VALUES = ['oval', 'diamond', 'squiggle'] as const;
/** Symbol colour. */
export const COLOR_VALUES = ['red', 'green', 'purple'] as const;
/** Symbol shading. */
export const FILL_VALUES = ['open', 'striped', 'solid'] as const;

export type CountName = (typeof COUNT_VALUES)[number];
export type ShapeName = (typeof SHAPE_VALUES)[number];
export type ColorName = (typeof COLOR_VALUES)[number];
export type FillName = (typeof FILL_VALUES)[number];

/** Human-readable value names per attribute, indexed by `AttrValue`. */
export const ATTRIBUTE_VALUE_NAMES = {
  count: COUNT_VALUES,
  shape: SHAPE_VALUES,
  color: COLOR_VALUES,
  fill: FILL_VALUES,
} as const satisfies Record<Attribute, readonly [string, string, string]>;

/**
 * A card id is its index in the canonical deck ordering, `0..80`:
 *
 *     id = count * 27 + shape * 9 + color * 3 + fill
 *
 * Using a small integer as the identity of a card keeps the wire protocol
 * compact and makes server-side validation trivial (`0 <= id <= 80`).
 */
export type CardId = number;

export const DECK_SIZE = 81;
export const VALUES_PER_ATTRIBUTE = 3;
export const SET_SIZE = 3;
/** Number of cards dealt to the board at the start of a game. */
export const INITIAL_BOARD_SIZE = 12;

export interface Card {
  readonly id: CardId;
  readonly count: AttrValue;
  readonly shape: AttrValue;
  readonly color: AttrValue;
  readonly fill: AttrValue;
}

/** Build a card from its four attribute values. */
export function makeCard(
  count: AttrValue,
  shape: AttrValue,
  color: AttrValue,
  fill: AttrValue,
): Card {
  return { id: count * 27 + shape * 9 + color * 3 + fill, count, shape, color, fill };
}

/** True when `id` is a valid card id (an integer in `0..80`). */
export function isCardId(id: unknown): id is CardId {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < DECK_SIZE;
}

/**
 * The canonical, ordered deck of all 81 distinct cards. Frozen so that no
 * consumer can mutate shared state; shuffling always produces a new array.
 */
export const DECK: readonly Card[] = Object.freeze(
  Array.from({ length: DECK_SIZE }, (_unused, id) =>
    Object.freeze({
      id,
      count: Math.floor(id / 27) as AttrValue,
      shape: (Math.floor(id / 9) % 3) as AttrValue,
      color: (Math.floor(id / 3) % 3) as AttrValue,
      fill: (id % 3) as AttrValue,
    }),
  ),
);

/** Look up a card by id. Throws on an out-of-range id, which is a programming error. */
export function cardById(id: CardId): Card {
  const card = DECK[id];
  if (!card) throw new RangeError(`Invalid card id: ${String(id)}`);
  return card;
}

/** Read one attribute of a card. */
export function attrOf(card: Card, attribute: Attribute): AttrValue {
  return card[attribute];
}

/** A stable, human/screen-reader friendly description, e.g. `two striped red diamond`. */
export function describeCard(card: Card): string {
  const count = COUNT_VALUES[card.count];
  const fill = FILL_VALUES[card.fill];
  const color = COLOR_VALUES[card.color];
  const shape = SHAPE_VALUES[card.shape];
  return `${count} ${fill} ${color} ${shape}${card.count === 0 ? '' : 's'}`;
}

/** All card ids in canonical order — a fresh, unshuffled deck. */
export function freshDeckIds(): CardId[] {
  return Array.from({ length: DECK_SIZE }, (_unused, i) => i);
}
