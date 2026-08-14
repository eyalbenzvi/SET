/**
 * The rules modal: three worked examples rendered with the real card renderer,
 * so what players learn here is exactly what they will see on the board.
 */

import { makeCard, type Card } from '@set/shared';
import { t } from '../../i18n/index.js';
import { createCardElement } from '../card.js';
import { button, el } from '../dom.js';

/** Same shape, colour and shading; one, two and three symbols. */
const VALID_COUNT_ONLY: Card[] = [makeCard(0, 1, 0, 2), makeCard(1, 1, 0, 2), makeCard(2, 1, 0, 2)];
/** Every attribute different. */
const VALID_ALL_DIFFERENT: Card[] = [
  makeCard(0, 0, 0, 0),
  makeCard(1, 1, 1, 1),
  makeCard(2, 2, 2, 2),
];
/** Two purple, one green — the colour attribute fails. */
const INVALID_TWO_PURPLE: Card[] = [
  makeCard(0, 2, 2, 1),
  makeCard(1, 2, 2, 1),
  makeCard(2, 2, 1, 1),
];

function exampleRow(cards: Card[], heading: string, valid: boolean): HTMLElement {
  const row = el('div', { class: 'tutorial__cards' });
  for (const card of cards) {
    const element = createCardElement(document, card.id);
    // Examples are illustrations, not controls.
    element.disabled = true;
    element.classList.add('card--static');
    row.appendChild(element);
  }
  return el('div', {
    class: `tutorial__example tutorial__example--${valid ? 'valid' : 'invalid'}`,
    children: [
      el('p', {
        class: 'tutorial__exampleHeading',
        children: [
          el('span', {
            class: 'tutorial__mark',
            text: valid ? '✓' : '✕',
            attrs: { 'aria-hidden': 'true' },
          }),
          el('span', { text: heading }),
        ],
      }),
      row,
    ],
  });
}

export function createTutorial(onClose: () => void): HTMLElement {
  const heading = el('h2', {
    class: 'modal__title',
    text: t('tutorial.title'),
    attrs: { id: 'tutorial-title' },
  });

  const panel = el('div', {
    class: 'modal__panel',
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tutorial-title',
      tabindex: '-1',
    },
    children: [
      heading,
      el('p', { class: 'modal__lead', text: t('tutorial.intro') }),
      el('p', { class: 'modal__label', text: t('tutorial.features') }),
      el('ul', {
        class: 'tutorial__list',
        children: [
          el('li', { text: t('tutorial.featureCount') }),
          el('li', { text: t('tutorial.featureShape') }),
          el('li', { text: t('tutorial.featureColor') }),
          el('li', { text: t('tutorial.featureFill') }),
        ],
      }),
      exampleRow(VALID_COUNT_ONLY, t('tutorial.validSameHeading'), true),
      exampleRow(VALID_ALL_DIFFERENT, t('tutorial.validAllDiffHeading'), true),
      exampleRow(INVALID_TWO_PURPLE, t('tutorial.invalidHeading'), false),
      el('p', { class: 'tutorial__why', text: t('tutorial.invalidWhy') }),

      // "Whose turn is it?" was the single most common confusion, so the flow is
      // spelled out point by point rather than in one dense paragraph.
      el('p', { class: 'modal__label', text: t('tutorial.flowTitle') }),
      el('ul', {
        class: 'tutorial__list tutorial__list--flow',
        children: [
          el('li', { text: t('tutorial.flowTurns') }),
          el('li', { text: t('tutorial.flowClaim') }),
          el('li', { text: t('tutorial.flowRefill') }),
          el('li', { text: t('tutorial.flowNoSet') }),
          el('li', { text: t('tutorial.flowMoreCards') }),
          el('li', { text: t('tutorial.flowHints') }),
          el('li', { text: t('tutorial.flowLastSet') }),
          el('li', { text: t('tutorial.flowDeck') }),
        ],
      }),
      button(t('tutorial.gotIt'), 'primary', onClose, { class: 'btn--block' }),
    ],
  });

  const overlay = el('div', {
    class: 'modal',
    children: [panel],
    on: {
      click: (event) => {
        if (event.target === event.currentTarget) onClose();
      },
      keydown: (event) => {
        if (event.key === 'Escape') {
          onClose();
          return;
        }
        if (event.key === 'Tab') trapFocus(panel, event);
      },
    },
  });

  // Focus the dialog so keyboard and screen-reader users land inside it, and put
  // focus back where it came from on close — `aria-modal` alone does not stop Tab
  // from wandering into the page behind the sheet.
  const previous = document.activeElement;
  queueMicrotask(() => panel.focus());
  overlay.addEventListener('modal:closed', () => {
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  });
  return overlay;
}

/** Keep Tab and Shift+Tab inside `panel`. */
function trapFocus(panel: HTMLElement, event: KeyboardEvent): void {
  const focusable = [
    ...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((node) => node.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
