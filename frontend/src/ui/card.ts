/**
 * Card rendering — every card is generated SVG. There are no image assets, no
 * fonts and no third-party artwork anywhere in this project; the three shapes
 * below are original paths drawn for this app.
 *
 * Accessibility notes:
 *  - Each card carries `data-count/shape/color/fill` attributes describing its
 *    four properties. Tests select on them, and they keep the DOM inspectable.
 *  - Each card has a full text label ("two striped red diamonds"), so colour is
 *    never the only channel carrying information.
 *  - The optional colour-assist marker adds a letter (R/G/P), for players who
 *    cannot separate the three hues.
 */

import {
  COLOR_VALUES,
  COUNT_VALUES,
  FILL_VALUES,
  SHAPE_VALUES,
  cardById,
  type Card,
  type CardId,
} from '@set/shared';
import { t, type StringKey } from '../i18n/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Symbol geometry is authored in a 100 x 52 box and tiled vertically. */
const SYMBOL_WIDTH = 100;
const SYMBOL_HEIGHT = 52;
const SYMBOL_GAP = 8;
const CARD_PADDING = 12;

/**
 * Shape outlines, authored for this project.
 *
 * `oval` is a stadium, `diamond` a rhombus, and `squiggle` a closed ribbon built
 * from two mirrored cubic curves — chosen because its silhouette stays clearly
 * different from the other two even at phone size and in solid fill.
 */
const SHAPE_PATHS: Record<number, string> = {
  // Oval (stadium): straight sides with fully rounded ends.
  0: 'M 26 3 H 74 A 23 23 0 0 1 74 49 H 26 A 23 23 0 0 1 26 3 Z',
  // Diamond.
  1: 'M 50 2 L 97 26 L 50 50 L 3 26 Z',
  // Squiggle: a wave-shaped ribbon.
  2:
    'M 6 34 C 4 12, 26 2, 46 14 C 62 24, 78 28, 94 16 ' +
    'C 96 40, 74 50, 54 38 C 38 28, 22 24, 6 34 Z',
};

export interface CardRenderOptions {
  /** Show the colour-assist letter marker. */
  colorAssist?: boolean;
}

/**
 * Human-readable, translated description used for `aria-label`.
 *
 * Reads as natural English ("two striped red diamonds"), because this string is
 * the entire card for a screen-reader user.
 */
export function cardLabel(card: Card): string {
  // Shape, colour and shading all inflect together. English spells the plural of
  // "red" and "striped" the same as the singular, but Hebrew does not
  // ("2 מעוינים אדומים מפוספסים"), so every slot has both forms.
  const plural = card.count > 0 ? 'Plural' : '';
  return t('game.cardLabel', {
    count: t(`value.count.${COUNT_VALUES[card.count]}` as StringKey),
    shape: t(`value.shape${plural}.${SHAPE_VALUES[card.shape]}` as StringKey),
    color: t(`value.color${plural}.${COLOR_VALUES[card.color]}` as StringKey),
    fill: t(`value.fill${plural}.${FILL_VALUES[card.fill]}` as StringKey),
  });
}

/** Letter shown by the colour-assist option: R / G / P. */
function colorInitial(card: Card): string {
  return t(`value.color.${COLOR_VALUES[card.color]}` as StringKey)
    .charAt(0)
    .toUpperCase();
}

/**
 * The shared `<defs>` block holding one stripe pattern per colour.
 *
 * Striped fill uses an SVG `<pattern>` rather than a CSS gradient because
 * patterns clip cleanly to an arbitrary path in every modern engine, which
 * gradients on a `fill` do not do reliably.
 */
export function createSvgDefs(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('svg-defs');
  const defs = doc.createElementNS(SVG_NS, 'defs');

  COLOR_VALUES.forEach((name, index) => {
    const pattern = doc.createElementNS(SVG_NS, 'pattern');
    pattern.setAttribute('id', `set-stripe-${name}`);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '8');
    pattern.setAttribute('height', '8');
    // Diagonal hatching reads as "striped" at every card size and cannot be
    // confused with the solid fill even in a screenshot at 3 columns wide.
    const line = doc.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', 'M 0 8 L 8 0');
    line.setAttribute('stroke', `var(--card-color-${index})`);
    line.setAttribute('stroke-width', '3.4');
    line.setAttribute('fill', 'none');
    pattern.appendChild(line);
    defs.appendChild(pattern);
  });

  svg.appendChild(defs);
  return svg;
}

/** The SVG artwork for one card: 1–3 symbols stacked and centred. */
function createArtwork(doc: Document, card: Card): SVGSVGElement {
  const symbols = card.count + 1;
  const height = symbols * SYMBOL_HEIGHT + (symbols - 1) * SYMBOL_GAP + CARD_PADDING * 2;
  const width = SYMBOL_WIDTH + CARD_PADDING * 2;

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'card__art');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const colorName = COLOR_VALUES[card.color];
  const colorVar = `var(--card-color-${card.color})`;

  for (let index = 0; index < symbols; index++) {
    const group = doc.createElementNS(SVG_NS, 'g');
    const offsetY = CARD_PADDING + index * (SYMBOL_HEIGHT + SYMBOL_GAP);
    group.setAttribute('transform', `translate(${CARD_PADDING} ${offsetY})`);

    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', SHAPE_PATHS[card.shape]!);
    path.setAttribute('stroke', colorVar);
    path.setAttribute('stroke-width', '4');
    path.setAttribute('stroke-linejoin', 'round');
    switch (card.fill) {
      case 0: // open
        path.setAttribute('fill', 'none');
        break;
      case 1: // striped
        path.setAttribute('fill', `url(#set-stripe-${colorName})`);
        break;
      default: // solid
        path.setAttribute('fill', colorVar);
        break;
    }
    group.appendChild(path);
    svg.appendChild(group);
  }
  return svg;
}

/**
 * Build one card button.
 *
 * A `<button>` is used deliberately: it is focusable, activates on Enter and
 * Space for free, and is announced as a control by screen readers.
 */
export function createCardElement(
  doc: Document,
  id: CardId,
  options: CardRenderOptions = {},
): HTMLButtonElement {
  const card = cardById(id);
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'card';
  button.dataset['cardId'] = String(id);
  button.dataset['count'] = COUNT_VALUES[card.count];
  button.dataset['shape'] = SHAPE_VALUES[card.shape];
  button.dataset['color'] = COLOR_VALUES[card.color];
  button.dataset['fill'] = FILL_VALUES[card.fill];
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', cardLabel(card));

  const inner = doc.createElement('span');
  inner.className = 'card__inner';
  inner.appendChild(createArtwork(doc, card));

  const badge = doc.createElement('span');
  badge.className = 'card__badge';
  badge.setAttribute('aria-hidden', 'true');
  inner.appendChild(badge);

  if (options.colorAssist) {
    const marker = doc.createElement('span');
    marker.className = 'card__assist';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = colorInitial(card);
    inner.appendChild(marker);
  }

  button.appendChild(inner);
  return button;
}

/**
 * Update a card element's selected state.
 *
 * Selection is signalled through four independent channels — border, elevation,
 * a numbered badge and `aria-pressed` — so it never depends on colour alone.
 */
export function setCardSelected(element: HTMLElement, position: number): void {
  const selected = position > 0;
  element.classList.toggle('card--selected', selected);
  element.setAttribute('aria-pressed', selected ? 'true' : 'false');
  const badge = element.querySelector<HTMLElement>('.card__badge');
  if (badge) badge.textContent = selected ? String(position) : '';
  const id = Number(element.dataset['cardId']);
  const base = cardLabel(cardById(id));
  element.setAttribute(
    'aria-label',
    selected ? `${base}, ${t('game.selectedPosition', { index: position })}` : base,
  );
}

/** Add a one-shot animation class, cleaned up when the animation ends. */
export function flashCard(element: HTMLElement, kind: 'good' | 'bad'): void {
  const className = kind === 'good' ? 'card--accepted' : 'card--rejected';
  element.classList.remove('card--accepted', 'card--rejected');
  // Force a reflow so re-adding the class restarts the animation.
  void element.offsetWidth;
  element.classList.add(className);
  const clear = (): void => {
    element.classList.remove(className);
    element.removeEventListener('animationend', clear);
  };
  element.addEventListener('animationend', clear);
}
