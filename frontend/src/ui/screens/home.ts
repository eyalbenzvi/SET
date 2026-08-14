/**
 * Home screen: create a game, or join one with a code.
 *
 * The join form is pre-filled when the player arrived through a share link, so
 * the fastest path from link to playing is: type a name, tap Continue.
 */

import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '@set/shared';
import { t } from '../../i18n/index.js';
import type { Store } from '../../state/store.js';
import { button, el } from '../dom.js';

function nameField(store: Store): HTMLElement {
  const input = el('input', {
    class: 'field__input',
    attrs: {
      id: 'player-name',
      type: 'text',
      inputmode: 'text',
      autocomplete: 'nickname',
      maxlength: String(MAX_NAME_LENGTH),
      placeholder: t('home.namePlaceholder'),
      'aria-describedby': 'form-error',
      enterkeyhint: 'go',
    },
  });
  input.value = store.getState().name;
  input.addEventListener('input', () => store.setName(input.value));
  return el('div', {
    class: 'field',
    children: [
      el('label', {
        class: 'field__label',
        text: t('home.nameLabel'),
        attrs: { for: 'player-name' },
      }),
      input,
    ],
  });
}

function codeField(store: Store): HTMLElement {
  const input = el('input', {
    class: 'field__input field__input--code',
    attrs: {
      id: 'room-code',
      type: 'text',
      inputmode: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: String(ROOM_CODE_LENGTH),
      placeholder: t('home.codePlaceholder'),
      'aria-describedby': 'form-error',
    },
  });
  input.value = store.getState().codeInput;
  input.addEventListener('input', () => {
    const caretAtEnd = input.selectionStart === input.value.length;
    store.setCodeInput(input.value);
    input.value = store.getState().codeInput;
    if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
  });
  return el('div', {
    class: 'field',
    children: [
      el('label', {
        class: 'field__label',
        text: t('home.codeLabel'),
        attrs: { for: 'room-code' },
      }),
      input,
    ],
  });
}

export function createHomeScreen(store: Store): HTMLElement {
  const state = store.getState();
  const busy = state.busy !== null;

  const errorNode = el('p', {
    class: 'form__error',
    attrs: { id: 'form-error', role: 'alert' },
    text: state.formError ?? '',
  });

  const brand = el('header', {
    class: 'hero',
    children: [
      el('h1', { class: 'hero__title', text: t('app.title') }),
      el('p', { class: 'hero__tagline', text: t('app.tagline') }),
      el('p', { class: 'hero__explain', text: t('home.explain') }),
    ],
  });

  let panel: HTMLElement;
  if (state.homeMode === 'menu') {
    panel = el('div', {
      class: 'panel',
      children: [
        button(t('home.create'), 'primary', () => store.setHomeMode('create'), {
          class: 'btn--block btn--lg',
          attrs: { 'data-testid': 'create-game' },
        }),
        button(t('home.join'), 'secondary', () => store.setHomeMode('join'), {
          class: 'btn--block btn--lg',
          attrs: { 'data-testid': 'join-game' },
        }),
        button(t('home.howToPlay'), 'ghost', () => store.setTutorialOpen(true), {
          class: 'btn--block',
          attrs: { 'data-testid': 'how-to-play' },
        }),
      ],
    });
  } else {
    const isJoin = state.homeMode === 'join';
    const submit = (): void => {
      void (isJoin ? store.submitJoin() : store.submitCreate());
    };
    const form = el('form', {
      class: 'panel',
      attrs: { novalidate: true },
      children: [
        isJoin ? codeField(store) : null,
        nameField(store),
        errorNode,
        button(
          busy ? (isJoin ? t('home.joining') : t('home.creating')) : t('home.continue'),
          'primary',
          submit,
          {
            disabled: busy,
            class: 'btn--block btn--lg',
            attrs: { 'data-testid': 'submit-name' },
          },
        ),
        button(t('common.back'), 'ghost', () => store.setHomeMode('menu'), {
          class: 'btn--block',
          disabled: busy,
        }),
      ],
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    panel = form;
  }

  return el('div', {
    class: 'screen screen--home',
    children: [brand, panel, state.homeMode === 'menu' ? errorNode : null],
  });
}
