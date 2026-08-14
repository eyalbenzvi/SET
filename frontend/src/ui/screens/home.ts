/**
 * Home screen: create a game, or join one with a code.
 *
 * This is a **persistent component**, not a render function, and that matters:
 * the inputs must survive every state change. Rebuilding the screen on each
 * keystroke destroys the focused `<input>`, which takes focus and the caret with
 * it — the field appears to eject you after every letter. So the DOM is built
 * once here and only its text and disabled states are patched afterwards.
 */

import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '@set/shared';
import { t } from '../../i18n/index.js';
import type { HomeMode, Store } from '../../state/store.js';
import { button, el } from '../dom.js';

export class HomeScreen {
  readonly root: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly codeField: HTMLElement;
  private readonly errorNode: HTMLElement;
  private readonly menuPanel: HTMLElement;
  private readonly formPanel: HTMLFormElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private lastMode: HomeMode | null = null;

  constructor(private readonly store: Store) {
    this.errorNode = el('p', {
      class: 'form__error',
      attrs: { id: 'form-error', role: 'alert' },
    });

    this.nameInput = el('input', {
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
    this.nameInput.value = store.getState().name;
    // `setName` deliberately does not re-render this screen; see `Store.setName`.
    this.nameInput.addEventListener('input', () => store.setName(this.nameInput.value));

    this.codeInput = el('input', {
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
    this.codeInput.value = store.getState().codeInput;
    this.codeInput.addEventListener('input', () => {
      // Normalise in place, preserving the caret, so typing never jumps.
      const caret = this.codeInput.selectionStart ?? this.codeInput.value.length;
      const atEnd = caret >= this.codeInput.value.length;
      const normalized = store.normalizeCodeInput(this.codeInput.value);
      if (normalized !== this.codeInput.value) {
        this.codeInput.value = normalized;
        const position = atEnd ? normalized.length : Math.min(caret, normalized.length);
        this.codeInput.setSelectionRange(position, position);
      }
    });

    this.codeField = el('div', {
      class: 'field',
      children: [
        el('label', {
          class: 'field__label',
          text: t('home.codeLabel'),
          attrs: { for: 'room-code' },
        }),
        this.codeInput,
      ],
    });

    const nameField = el('div', {
      class: 'field',
      children: [
        el('label', {
          class: 'field__label',
          text: t('home.nameLabel'),
          attrs: { for: 'player-name' },
        }),
        this.nameInput,
      ],
    });

    this.submitButton = button(t('home.continue'), 'primary', () => this.submit(), {
      class: 'btn--block btn--lg',
      attrs: { 'data-testid': 'submit-name' },
    });
    this.backButton = button(t('common.back'), 'ghost', () => this.store.setHomeMode('menu'), {
      class: 'btn--block',
    });

    this.formPanel = el('form', {
      class: 'panel',
      attrs: { novalidate: true },
      children: [this.codeField, nameField, this.errorNode, this.submitButton, this.backButton],
    });
    this.formPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    this.menuPanel = el('div', {
      class: 'panel',
      children: [
        button(t('home.create'), 'primary', () => this.store.setHomeMode('create'), {
          class: 'btn--block btn--lg',
          attrs: { 'data-testid': 'create-game' },
        }),
        button(t('home.join'), 'secondary', () => this.store.setHomeMode('join'), {
          class: 'btn--block btn--lg',
          attrs: { 'data-testid': 'join-game' },
        }),
        button(t('home.howToPlay'), 'ghost', () => this.store.setTutorialOpen(true), {
          class: 'btn--block',
          attrs: { 'data-testid': 'how-to-play' },
        }),
      ],
    });

    this.root = el('div', {
      class: 'screen screen--home',
      children: [
        el('header', {
          class: 'hero',
          children: [
            el('h1', { class: 'hero__title', text: t('app.title') }),
            el('p', { class: 'hero__tagline', text: t('app.tagline') }),
            el('p', { class: 'hero__explain', text: t('home.explain') }),
          ],
        }),
        this.menuPanel,
        this.formPanel,
      ],
    });
  }

  private submit(): void {
    if (this.store.getState().homeMode === 'join') void this.store.submitJoin();
    else void this.store.submitCreate();
  }

  /** Patch text and disabled states. Never rebuilds the inputs. */
  update(): void {
    const state = this.store.getState();
    const busy = state.busy !== null;
    const isMenu = state.homeMode === 'menu';
    const isJoin = state.homeMode === 'join';

    this.menuPanel.hidden = !isMenu;
    this.formPanel.hidden = isMenu;
    this.codeField.hidden = !isJoin;

    this.errorNode.textContent = state.formError ?? '';
    this.submitButton.disabled = busy;
    this.backButton.disabled = busy;
    this.submitButton.textContent = busy
      ? isJoin
        ? t('home.joining')
        : t('home.creating')
      : t('home.continue');

    // Only touch the inputs when the store's value genuinely diverges (a join
    // link pre-filling the code, say) — never while the player is typing into it.
    if (document.activeElement !== this.codeInput && this.codeInput.value !== state.codeInput) {
      this.codeInput.value = state.codeInput;
    }
    if (document.activeElement !== this.nameInput && this.nameInput.value !== state.name) {
      this.nameInput.value = state.name;
    }

    // Focus the first empty field when the panel changes, so the keyboard opens
    // where the player needs it.
    if (this.lastMode !== state.homeMode) {
      this.lastMode = state.homeMode;
      if (!isMenu) {
        const target =
          isJoin && this.codeInput.value.length === 0 ? this.codeInput : this.nameInput;
        queueMicrotask(() => target.focus({ preventScroll: true }));
      }
    }
  }
}
