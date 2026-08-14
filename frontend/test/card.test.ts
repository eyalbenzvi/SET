/**
 * Card rendering tests: the generated SVG must faithfully represent the card
 * data, and must describe itself for assistive technology.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLOR_VALUES, DECK, cardById, makeCard } from '@set/shared';
import { setLocale } from '../src/i18n/index.js';
import {
  cardLabel,
  createCardElement,
  createMiniCard,
  createSvgDefs,
  flashCard,
  setCardState,
} from '../src/ui/card.js';

// Hebrew is the app's default locale; these assertions are about the English
// wording, so pin it. A Hebrew case is covered at the end of the file.
beforeAll(() => {
  setLocale('en');
});

describe('createSvgDefs', () => {
  it('defines one stripe pattern per colour', () => {
    const svg = createSvgDefs(document);
    const patterns = svg.querySelectorAll('pattern');
    expect(patterns).toHaveLength(3);
    const ids = [...patterns].map((pattern) => pattern.getAttribute('id'));
    expect(ids).toEqual(COLOR_VALUES.map((name) => `set-stripe-${name}`));
    for (const pattern of patterns) {
      expect(pattern.getAttribute('patternUnits')).toBe('userSpaceOnUse');
      expect(pattern.querySelector('path')).not.toBeNull();
    }
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('createCardElement', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('draws exactly as many symbols as the card has', () => {
    for (const count of [0, 1, 2] as const) {
      const card = makeCard(count, 1, 0, 2);
      const element = createCardElement(document, card.id);
      expect(element.querySelectorAll('.card__art path')).toHaveLength(count + 1);
    }
  });

  it('exposes all four properties as data attributes for every card in the deck', () => {
    for (const card of DECK) {
      const element = createCardElement(document, card.id);
      expect(element.dataset['cardId']).toBe(String(card.id));
      expect(element.dataset['count']).toBe(['one', 'two', 'three'][card.count]);
      expect(element.dataset['shape']).toBe(['oval', 'diamond', 'squiggle'][card.shape]);
      expect(element.dataset['color']).toBe(['red', 'green', 'purple'][card.color]);
      expect(element.dataset['fill']).toBe(['open', 'striped', 'solid'][card.fill]);
    }
  });

  it('paints each shading style with the right kind of fill', () => {
    const open = createCardElement(document, makeCard(0, 0, 0, 0).id);
    expect(open.querySelector('.card__art path')!.getAttribute('fill')).toBe('none');

    const striped = createCardElement(document, makeCard(0, 0, 1, 1).id);
    expect(striped.querySelector('.card__art path')!.getAttribute('fill')).toBe(
      'url(#set-stripe-green)',
    );

    const solid = createCardElement(document, makeCard(0, 0, 2, 2).id);
    expect(solid.querySelector('.card__art path')!.getAttribute('fill')).toBe(
      'var(--card-color-2)',
    );
  });

  it('uses a distinct outline for each shape', () => {
    const paths = [0, 1, 2].map((shape) => {
      const element = createCardElement(document, makeCard(0, shape as 0 | 1 | 2, 0, 0).id);
      return element.querySelector('.card__art path')!.getAttribute('d');
    });
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) expect(path).toBeTruthy();
  });

  it('strokes every symbol in the card colour, so open cards are still visible', () => {
    for (const card of DECK) {
      const element = createCardElement(document, card.id);
      for (const path of element.querySelectorAll('.card__art path')) {
        expect(path.getAttribute('stroke')).toBe(`var(--card-color-${card.color})`);
      }
    }
  });

  it('is a real button, so keyboard activation works without extra code', () => {
    const element = createCardElement(document, 0);
    expect(element.tagName).toBe('BUTTON');
    expect(element.type).toBe('button');
    expect(element.getAttribute('aria-pressed')).toBe('false');
  });

  it('labels the card with all four properties in words', () => {
    const element = createCardElement(document, makeCard(1, 1, 0, 1).id);
    const label = element.getAttribute('aria-label') ?? '';
    expect(label).toBe('two striped red diamonds');
    expect(label).toBe(cardLabel(cardById(makeCard(1, 1, 0, 1).id)));
  });

  it('uses singular wording for single-symbol cards', () => {
    expect(cardLabel(makeCard(0, 0, 1, 2))).toBe('one solid green oval');
  });

  it('omits the colour-assist marker unless asked for', () => {
    expect(createCardElement(document, 0).querySelector('.card__assist')).toBeNull();
    const assisted = createCardElement(document, 0, { colorAssist: true });
    expect(assisted.querySelector('.card__assist')?.textContent).toBe('R');
    expect(assisted.querySelector('.card__assist')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks the assist letter per colour', () => {
    const letters = [0, 1, 2].map(
      (color) =>
        createCardElement(document, makeCard(0, 0, color as 0 | 1 | 2, 0).id, {
          colorAssist: true,
        }).querySelector('.card__assist')?.textContent,
    );
    expect(letters).toEqual(['R', 'G', 'P']);
  });

  it('never injects markup from card data', () => {
    const element = createCardElement(document, 40);
    expect(element.querySelectorAll('script')).toHaveLength(0);
    expect(element.innerHTML).not.toContain('<script');
  });
});

describe('setCardState', () => {
  it('signals selection through class, aria-pressed, a numbered badge and the label', () => {
    const element = createCardElement(document, makeCard(1, 1, 0, 1).id);
    setCardState(element, 2);
    expect(element.classList.contains('card--selected')).toBe(true);
    expect(element.getAttribute('aria-pressed')).toBe('true');
    expect(element.querySelector('.card__badge')?.textContent).toBe('2');
    expect(element.getAttribute('aria-label')).toBe(
      'two striped red diamonds, selected, position 2 of 3',
    );
  });

  it('clears every selection cue when deselected', () => {
    const element = createCardElement(document, 5);
    setCardState(element, 1);
    setCardState(element, 0);
    expect(element.classList.contains('card--selected')).toBe(false);
    expect(element.getAttribute('aria-pressed')).toBe('false');
    expect(element.querySelector('.card__badge')?.textContent).toBe('');
    expect(element.getAttribute('aria-label')).toBe(cardLabel(cardById(5)));
  });

  it('marks a hinted card with a class, a corner mark and the label', () => {
    const element = createCardElement(document, makeCard(1, 1, 0, 1).id);
    setCardState(element, 0, true);
    expect(element.classList.contains('card--hinted')).toBe(true);
    expect(element.querySelector('.card__hintMark')?.textContent).toBe('?');
    expect(element.getAttribute('aria-label')).toBe('two striped red diamonds, marked by a hint');
    // Not a selection: nothing about the pressed state changes.
    expect(element.getAttribute('aria-pressed')).toBe('false');
  });

  it('describes a card that is both hinted and selected', () => {
    const element = createCardElement(document, makeCard(1, 1, 0, 1).id);
    setCardState(element, 1, true);
    expect(element.getAttribute('aria-label')).toBe(
      'two striped red diamonds, selected, position 1 of 3, marked by a hint',
    );
  });

  it('drops the hint cue again when the hint no longer applies', () => {
    const element = createCardElement(document, 5);
    setCardState(element, 0, true);
    setCardState(element, 0, false);
    expect(element.classList.contains('card--hinted')).toBe(false);
    expect(element.querySelector('.card__hintMark')?.textContent).toBe('');
    expect(element.getAttribute('aria-label')).toBe(cardLabel(cardById(5)));
  });
});

describe('createMiniCard', () => {
  it('renders a labelled, non-interactive card face', () => {
    const element = createMiniCard(document, makeCard(1, 1, 0, 1).id);
    expect(element.tagName).toBe('SPAN');
    expect(element.getAttribute('role')).toBe('img');
    expect(element.getAttribute('aria-label')).toBe('two striped red diamonds');
    expect(element.querySelectorAll('.card__art path')).toHaveLength(2);
    // Nothing focusable inside, so it never becomes a dead tab stop.
    expect(element.querySelector('button')).toBeNull();
  });
});

describe('Hebrew labels', () => {
  beforeEach(() => {
    setLocale('he');
  });
  afterEach(() => {
    setLocale('en');
  });

  it('describes a card in Hebrew, with the count as a digit and the adjectives agreeing', () => {
    // A digit reads idiomatically before a Hebrew plural noun, and the colour and
    // shading inflect with it — "2 מעוינים אדומים מפוספסים", not "אדום מפוספס".
    expect(cardLabel(makeCard(1, 1, 0, 1))).toBe('2 מעוינים אדומים מפוספסים');
  });

  it('uses the singular shape for a one-symbol card', () => {
    expect(cardLabel(makeCard(0, 0, 1, 2))).toBe('1 סגלגל ירוק מלא');
  });

  it('derives the colour-assist letter from the Hebrew colour names', () => {
    const letters = [0, 1, 2].map(
      (color) =>
        createCardElement(document, makeCard(0, 0, color as 0 | 1 | 2, 0).id, {
          colorAssist: true,
        }).querySelector('.card__assist')?.textContent,
    );
    expect(letters).toEqual(['א', 'י', 'ס']);
  });
});

describe('flashCard', () => {
  it('adds a one-shot class and removes it when the animation ends', () => {
    const element = createCardElement(document, 3);
    document.body.appendChild(element);
    flashCard(element, 'good');
    expect(element.classList.contains('card--accepted')).toBe(true);
    element.dispatchEvent(new Event('animationend'));
    expect(element.classList.contains('card--accepted')).toBe(false);
  });

  it('replaces a previous flash rather than stacking classes', () => {
    const element = createCardElement(document, 3);
    document.body.appendChild(element);
    flashCard(element, 'good');
    flashCard(element, 'bad');
    expect(element.classList.contains('card--accepted')).toBe(false);
    expect(element.classList.contains('card--rejected')).toBe(true);
  });
});
