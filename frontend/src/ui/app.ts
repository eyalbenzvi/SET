/**
 * Application shell.
 *
 * Owns the screen switch, the connection banner, the toast stack, the polite
 * live region and the settings/tutorial overlays. The game screen is a
 * persistent component (see `screens/game.ts`); the others are re-rendered on
 * change, which is cheap because they are small and static.
 */

import {
  LOCALE_NAMES,
  LOCALES_AVAILABLE,
  direction,
  getLocale,
  setLocale,
  t,
  type Locale,
} from '../i18n/index.js';
import type { Store } from '../state/store.js';
import { createSvgDefs } from './card.js';
import { button, el, render } from './dom.js';
import { HomeScreen } from './screens/home.js';
import { createLobbyScreen } from './screens/lobby.js';
import { GameScreen } from './screens/game.js';
import { createResultsScreen } from './screens/results.js';
import { createTutorial } from './screens/tutorial.js';

export class App {
  private readonly screenHost: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly toastHost: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly overlayHost: HTMLElement;
  private gameScreen: GameScreen | null = null;
  private unmountGame: (() => void) | null = null;
  private homeScreen: HomeScreen | null = null;
  private lastAnnouncement = '';

  constructor(
    private readonly store: Store,
    private readonly root: HTMLElement,
  ) {
    this.banner = el('div', { class: 'banner', attrs: { role: 'status', hidden: true } });
    this.screenHost = el('div', { class: 'screenHost' });
    this.toastHost = el('div', { class: 'toasts', attrs: { 'aria-hidden': 'true' } });
    // Announcements are polite so they never interrupt what a player is reading.
    this.liveRegion = el('div', {
      class: 'visuallyHidden',
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.overlayHost = el('div', { class: 'overlayHost' });

    this.rebuild();
  }

  /** (Re)compose the shell and apply the active locale's text direction. */
  private rebuild(): void {
    this.homeScreen = null;
    this.gameScreen = null;
    this.unmountGame?.();
    this.unmountGame = null;
    this.lastAnnouncement = '';
    render(
      this.root,
      createSvgDefs(document),
      this.banner,
      this.screenHost,
      this.toastHost,
      this.liveRegion,
      this.overlayHost,
      this.settingsBar(),
    );
    document.documentElement.setAttribute('dir', direction());
    document.documentElement.setAttribute('lang', getLocale());
    this.render();
  }

  start(): void {
    this.store.subscribe(() => this.render());
    this.render();
  }

  /** Display options, available from every screen. */
  private settingsBar(): HTMLElement {
    const input = el('input', {
      class: 'switch__input',
      attrs: { type: 'checkbox', id: 'color-assist' },
    });
    input.checked = this.store.getState().settings.colorAssist;
    input.addEventListener('change', () => this.store.setColorAssist(input.checked));

    return el('div', {
      class: 'settingsBar',
      children: [
        el('label', {
          class: 'switch',
          attrs: { for: 'color-assist', title: t('settings.colorAssistHint') },
          children: [
            input,
            el('span', { class: 'switch__track', attrs: { 'aria-hidden': 'true' } }),
            el('span', { class: 'switch__label', text: t('settings.colorAssist') }),
          ],
        }),
        this.languageSwitch(),
      ],
    });
  }

  /**
   * Language switch. Changing language rebuilds the whole shell, because every
   * built string and the document's text direction are captured at build time.
   */
  private languageSwitch(): HTMLElement {
    const buttons = LOCALES_AVAILABLE.map((locale) =>
      button(
        LOCALE_NAMES[locale],
        locale === getLocale() ? 'secondary' : 'ghost',
        () => this.changeLocale(locale),
        {
          class: `btn--tiny${locale === getLocale() ? ' btn--current' : ''}`,
          attrs: {
            'data-testid': `lang-${locale}`,
            'aria-pressed': locale === getLocale() ? 'true' : 'false',
          },
        },
      ),
    );
    return el('div', {
      class: 'langSwitch',
      attrs: { role: 'group', 'aria-label': t('settings.language') },
      children: buttons,
    });
  }

  private changeLocale(locale: Locale): void {
    if (locale === getLocale()) return;
    setLocale(locale);
    this.rebuild();
  }

  private render(): void {
    const state = this.store.getState();
    // Pins the page to one viewport while playing; see `body.is-playing`.
    document.body.classList.toggle('is-playing', state.screen === 'game');
    this.renderBanner();
    this.renderToasts();
    this.renderLive();
    this.renderOverlays();

    if (state.screen === 'game') {
      if (!this.gameScreen) {
        this.gameScreen = new GameScreen(this.store);
        this.unmountGame = this.gameScreen.mount();
        render(this.screenHost, this.gameScreen.root);
      }
      this.gameScreen.update();
      return;
    }

    if (this.gameScreen) {
      this.unmountGame?.();
      this.unmountGame = null;
      this.gameScreen = null;
    }
    if (state.screen !== 'home') this.homeScreen = null;

    switch (state.screen) {
      case 'home': {
        // Persistent: rebuilding it would destroy the focused input on every
        // keystroke. Built once, patched thereafter.
        if (!this.homeScreen) {
          this.homeScreen = new HomeScreen(this.store);
          render(this.screenHost, this.homeScreen.root);
        }
        this.homeScreen.update();
        break;
      }
      case 'lobby':
        render(this.screenHost, createLobbyScreen(this.store));
        break;
      case 'results':
        render(this.screenHost, createResultsScreen(this.store));
        break;
      case 'fatal':
        render(this.screenHost, this.fatalScreen());
        break;
      default:
        break;
    }
  }

  /** Non-technical error screen with concrete ways out. */
  private fatalScreen(): HTMLElement {
    const state = this.store.getState();
    const fatal = state.fatal;
    const actions: HTMLElement[] = [];
    for (const action of fatal?.actions ?? []) {
      if (action === 'retry') {
        actions.push(
          button(t('common.retry'), 'primary', () => this.store.retryConnection(), {
            class: 'btn--block btn--lg',
            attrs: { 'data-testid': 'error-retry' },
          }),
        );
      } else if (action === 'reload') {
        actions.push(
          button(t('error.reload'), 'primary', () => globalThis.location.reload(), {
            class: 'btn--block btn--lg',
          }),
        );
      } else {
        actions.push(
          button(t('common.home'), 'secondary', () => this.store.goHome(), {
            class: 'btn--block',
            attrs: { 'data-testid': 'error-home' },
          }),
        );
      }
    }
    return el('div', {
      class: 'screen screen--error',
      children: [
        el('div', {
          class: 'panel panel--error',
          children: [
            el('h1', { class: 'screen__title', text: t('error.title') }),
            el('p', {
              class: 'error__message',
              text: fatal?.message ?? t('error.generic'),
              attrs: { 'data-testid': 'error-message' },
            }),
            ...actions,
          ],
        }),
      ],
    });
  }

  private renderBanner(): void {
    const state = this.store.getState();
    let text = '';
    let tone = 'info';
    if (state.connection === 'connecting' && !state.room) {
      text = t('status.connecting');
    } else if (state.connection === 'reconnecting') {
      text = t('status.reconnecting', { attempt: Math.max(state.connectionAttempt, 1) });
      tone = 'warn';
    }
    const visible = text.length > 0 && state.screen !== 'fatal';
    this.banner.textContent = text;
    this.banner.dataset['tone'] = tone;
    this.banner.hidden = !visible;
  }

  private renderToasts(): void {
    const { toasts, screen } = this.store.getState();
    // During play the feed lives in the header instead, so nothing floats over
    // the board or the action bar.
    if (screen === 'game') {
      this.toastHost.replaceChildren();
      return;
    }
    this.toastHost.replaceChildren(
      ...toasts.map((toast) =>
        el('div', {
          class: `toast toast--${toast.tone}`,
          text: toast.text,
          attrs: { 'data-testid': 'toast' },
        }),
      ),
    );
  }

  private renderLive(): void {
    const { announcement } = this.store.getState();
    if (announcement === this.lastAnnouncement) return;
    this.lastAnnouncement = announcement;
    this.liveRegion.textContent = announcement;
  }

  private renderOverlays(): void {
    const { tutorialOpen } = this.store.getState();
    const open = this.overlayHost.firstElementChild !== null;
    if (tutorialOpen && !open) {
      render(
        this.overlayHost,
        createTutorial(() => this.store.setTutorialOpen(false)),
      );
    } else if (!tutorialOpen && open) {
      // Let the overlay hand focus back to whatever opened it before it goes.
      this.overlayHost.firstElementChild?.dispatchEvent(new CustomEvent('modal:closed'));
      render(this.overlayHost);
    }
  }
}
