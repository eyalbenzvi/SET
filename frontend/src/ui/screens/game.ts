/**
 * The game board.
 *
 * Unlike the other screens this one is a long-lived component rather than a
 * re-render: card elements are reused across state updates and only patched in
 * place. That keeps CSS animations from restarting, keeps keyboard focus on the
 * card the player is on, and avoids rebuilding SVG on every broadcast.
 *
 * Layout is a fixed score strip, a scrollable board, and a fixed action bar, so
 * the primary controls can never be pushed off a small screen.
 */

import { MAX_BOARD_SIZE, SET_SIZE, type CardId, type HintLevel } from '@set/shared';
import { t, type StringKey } from '../../i18n/index.js';
import type { Effect, Store } from '../../state/store.js';
import { selectionIndex } from '../../state/selection.js';
import { createCardElement, createMiniCard, flashCard, setCardState } from '../card.js';
import { button, el, prefersReducedMotion } from '../dom.js';
import { computeLayout } from '../grid.js';

/** Seconds as `m:ss`, so a two-minute countdown stays two characters wide. */
function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : String(seconds);
}

export class GameScreen {
  readonly root: HTMLElement;
  private readonly scores: HTMLElement;
  private readonly board: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly claimButton: HTMLButtonElement;
  private readonly deckCounter: HTMLElement;
  private readonly setsCounter: HTMLElement;
  /** Hint level 1 and 2, unlocking on time spent on the current board. */
  private readonly hintButtons: Record<HintLevel, HTMLButtonElement>;
  /** Asks the table for three more cards; also shows how many have agreed. */
  private readonly moreButton: HTMLButtonElement;
  /** Covers the board while a proven set-less position is being replaced. */
  private readonly noSetNotice: HTMLElement;
  /** "X took [three cards]" — what the set actually was. */
  private readonly lastSet: HTMLElement;
  private readonly lastSetText: HTMLElement;
  private readonly lastSetCards: HTMLElement;
  private lastSetId = -1;
  /** Card elements by card id, reused while the card stays on the board. */
  private readonly cardElements = new Map<CardId, HTMLButtonElement>();
  /** Layer holding cards that are animating off the board. */
  private readonly ghosts: HTMLElement;
  /** One-line activity feed, in the header where it cannot cover a card. */
  private readonly feed: HTMLElement;
  private cooldownTimer: ReturnType<typeof setInterval> | null = null;
  private layoutKey = '';
  private lastFeedId = -1;
  private lastColorAssist: boolean;
  /** Set by the first tap on Leave; a second tap within the window commits. */
  private leaveArmed = false;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly leaveButton: HTMLButtonElement;

  constructor(private readonly store: Store) {
    this.lastColorAssist = store.getState().settings.colorAssist;

    this.scores = el('div', {
      class: 'scores',
      // A labelled list, so a screen reader can walk the scores instead of
      // meeting an unlabelled row of divs.
      attrs: { 'data-testid': 'scores', role: 'list', 'aria-label': t('game.scoresLabel') },
    });
    this.deckCounter = el('span', { class: 'meter__value' });
    this.setsCounter = el('span', { class: 'meter__value' });
    this.board = el('div', {
      class: 'board',
      attrs: { role: 'group', 'data-testid': 'board' },
    });
    this.ghosts = el('div', { class: 'board__ghosts', attrs: { 'aria-hidden': 'true' } });
    this.feed = el('p', {
      class: 'feed',
      attrs: { 'data-testid': 'feed', 'aria-hidden': 'true' },
    });
    this.feedback = el('p', {
      class: 'feedback',
      attrs: { 'data-testid': 'feedback', role: 'status' },
    });

    this.claimButton = button(t('game.claim'), 'primary', () => this.store.claim(), {
      class: 'btn--claim',
      attrs: { 'data-testid': 'claim' },
    });
    this.leaveButton = button(t('game.leave'), 'ghost', () => this.onLeaveTapped(), {
      class: 'btn--tiny',
      attrs: { 'data-testid': 'leave-game' },
    });

    this.hintButtons = {
      1: this.hintButton(1),
      2: this.hintButton(2),
    };
    // Sits beside "Claim SET" rather than among the small chips: it is the one
    // thing a stuck table does together, and it needs to be found without
    // hunting for it.
    this.moreButton = button(t('game.moreCards'), 'secondary', () => this.store.toggleMoreCards(), {
      class: 'btn--more',
      attrs: { 'data-testid': 'more-cards' },
    });

    // Announced by the server, never by a player. It sits over the board because
    // the board is exactly what it is telling everyone to stop reading.
    this.noSetNotice = el('div', {
      class: 'noSetNotice',
      attrs: { 'data-testid': 'no-set-notice', role: 'status', hidden: 'hidden' },
      children: [
        el('span', { class: 'noSetNotice__title', text: t('game.noSetOnBoard') }),
        el('span', { class: 'noSetNotice__sub', text: t('game.noSetAdding') }),
      ],
    });

    this.lastSetText = el('span', { class: 'lastSet__who' });
    this.lastSetCards = el('span', { class: 'lastSet__cards' });
    this.lastSet = el('div', {
      class: 'lastSet',
      attrs: { 'data-testid': 'last-set', hidden: 'hidden' },
      children: [this.lastSetText, this.lastSetCards],
    });

    this.root = el('div', {
      class: 'screen screen--game',
      children: [
        el('header', {
          class: 'gameHeader',
          children: [
            this.scores,
            el('div', {
              class: 'meters',
              children: [
                el('span', {
                  class: 'meter',
                  children: [
                    el('span', {
                      class: 'meter__label',
                      text: '🂠',
                      attrs: { 'aria-hidden': 'true' },
                    }),
                    this.deckCounter,
                  ],
                }),
                el('span', {
                  class: 'meter',
                  children: [
                    el('span', {
                      class: 'meter__label',
                      text: '✓',
                      attrs: { 'aria-hidden': 'true' },
                    }),
                    this.setsCounter,
                  ],
                }),
                this.leaveButton,
              ],
            }),
            // One row, one height: the feed line and the set that was just taken
            // share it and never both show, so the board is never resized by a
            // message appearing or expiring under it.
            el('div', { class: 'headline', children: [this.feed, this.lastSet] }),
          ],
        }),
        el('main', { class: 'boardWrap', children: [this.board, this.ghosts, this.noSetNotice] }),
        el('footer', {
          class: 'actionBar',
          children: [
            // The two hints sit above the decisive buttons, in a smaller size:
            // they are things you reach for occasionally, and mixing them into the
            // same row as "Claim SET" would invite a mis-tap in a race.
            el('div', {
              class: 'actionBar__aids',
              children: [this.hintButtons[1], this.hintButtons[2]],
            }),
            this.feedback,
            el('div', {
              class: 'actionBar__buttons',
              children: [this.moreButton, this.claimButton],
            }),
          ],
        }),
      ],
    });

    this.board.addEventListener('click', (event) => this.onBoardClick(event));
  }

  /** Start the cooldown ticker and effect subscription. */
  mount(): () => void {
    const unsubscribeEffects = this.store.onEffect((effect) => this.playEffect(effect));
    // One shared timer drives the countdown label; nothing else polls.
    this.cooldownTimer = setInterval(() => this.updateActions(), 250);
    const onResize = (): void => this.updateLayout();
    globalThis.addEventListener('resize', onResize);
    globalThis.addEventListener('orientationchange', onResize);
    // A ResizeObserver is what makes the fit-to-viewport layout reliable: the
    // first measurement happens before the element has been laid out, and the
    // header height changes when score chips wrap. Both arrive here.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.updateLayout()) : null;
    const wrap = this.board.parentElement;
    if (observer && wrap) observer.observe(wrap);
    return () => {
      unsubscribeEffects();
      if (this.cooldownTimer !== null) clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
      observer?.disconnect();
      if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
      globalThis.removeEventListener('resize', onResize);
      globalThis.removeEventListener('orientationchange', onResize);
    };
  }

  update(): void {
    this.updateScores();
    this.updateBoard();
    this.updateActions();
    this.updateFeed();
    this.updateLastSet();
    this.updateLayout();
  }

  /** One hint button. Level 2 marks two cards, which fixes the third. */
  private hintButton(level: HintLevel): HTMLButtonElement {
    return button(
      t(`game.hint${level}` as StringKey),
      'ghost',
      () => this.store.requestHint(level),
      { class: 'btn--chip', attrs: { 'data-testid': `hint-${level}` } },
    );
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  private updateScores(): void {
    const state = this.store.getState();
    const room = state.room;
    if (!room) return;
    this.scores.replaceChildren(
      ...this.store.ranked().map((player) => {
        const classes = ['scoreChip'];
        if (player.id === state.meId) classes.push('scoreChip--me');
        if (!player.connected) classes.push('scoreChip--offline');
        if (player.cooldownUntil > room.serverTime) classes.push('scoreChip--cooling');
        return el('div', {
          class: classes.join(' '),
          attrs: {
            'data-player-name': player.name,
            'data-testid': 'score-chip',
            role: 'listitem',
            'aria-label': t('game.playerScore', { name: player.name, score: player.score }),
          },
          children: [
            el('span', {
              class: 'scoreChip__name',
              text: player.name,
              attrs: { 'aria-hidden': 'true' },
            }),
            el('span', {
              class: 'scoreChip__score',
              text: String(player.score),
              attrs: { 'aria-hidden': 'true' },
            }),
          ],
        });
      }),
    );
    // Visible text is terse; the accessible name spells the meaning out.
    this.deckCounter.textContent = t('game.deckLeft', { count: room.deckRemaining });
    this.deckCounter.setAttribute(
      'aria-label',
      t('game.deckLeftLabel', { count: room.deckRemaining }),
    );
    this.setsCounter.textContent = t('game.setsFound', { count: room.setsFound });
    this.setsCounter.setAttribute(
      'aria-label',
      t('game.setsFoundLabel', { count: room.setsFound }),
    );
  }

  /**
   * Reconcile the board against the authoritative card list.
   *
   * Cards that stayed keep their DOM node (and therefore their position in the
   * grid and any running animation); only added and removed slots change.
   */
  private updateBoard(): void {
    const state = this.store.getState();
    const room = state.room;
    if (!room) return;

    if (this.lastColorAssist !== state.settings.colorAssist) {
      // The assist marker is baked into each card, so rebuild them all once.
      this.lastColorAssist = state.settings.colorAssist;
      this.cardElements.clear();
      this.board.replaceChildren();
    }

    // Retire departing cards first: their geometry must be read while they are
    // still laid out in the grid.
    const wanted = new Set(room.board);
    for (const [id, element] of [...this.cardElements]) {
      if (wanted.has(id)) continue;
      this.cardElements.delete(id);
      this.retireCard(element);
    }

    // Where the keyboard was, so focus can be handed to whatever takes that slot.
    const focused = document.activeElement;
    const focusedSlot =
      focused instanceof HTMLElement && focused.classList.contains('card')
        ? [...this.board.children].indexOf(focused)
        : -1;

    // Patch the DOM in place rather than replacing it wholesale: detaching and
    // re-attaching a focused element blurs it, which would strand keyboard and
    // screen-reader users on every board update.
    const hinted = new Set(this.store.activeHint()?.cards ?? []);
    room.board.forEach((id, slot) => {
      let element = this.cardElements.get(id);
      if (!element) {
        element = createCardElement(document, id, { colorAssist: state.settings.colorAssist });
        this.cardElements.set(id, element);
        if (!prefersReducedMotion()) element.classList.add('card--enter');
      }
      setCardState(element, selectionIndex(state.selection, id), hinted.has(id));
      const current = this.board.children[slot];
      if (current !== element) this.board.insertBefore(element, current ?? null);
    });
    while (this.board.children.length > room.board.length) {
      this.board.lastElementChild?.remove();
    }
    this.board.setAttribute('aria-label', t('game.boardLabel', { count: room.board.length }));

    // If the focused card was claimed away, move focus to the card now in its
    // place instead of dropping the player back to the top of the document.
    if (focusedSlot >= 0 && !this.board.contains(focused)) {
      const replacement =
        this.board.children[Math.min(focusedSlot, this.board.children.length - 1)];
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
    }
  }

  private updateActions(): void {
    const state = this.store.getState();
    const seconds = this.store.cooldownSeconds();
    const cooling = seconds > 0;
    const selected = state.selection.length;
    const noSet = this.store.noSetPending();

    this.claimButton.disabled = cooling || noSet || selected !== SET_SIZE;
    this.claimButton.textContent = cooling
      ? t('game.cooldown', { seconds })
      : selected === SET_SIZE
        ? t('game.claim')
        : t('game.claimSelected', { count: selected });

    const feedback = state.feedback;
    // "Select three cards" would be a lie while the board is out of play, and a
    // countdown already spells out a cooldown on the button itself.
    this.feedback.textContent = feedback?.text ?? (cooling || noSet ? '' : t('game.selectThree'));
    this.feedback.dataset['tone'] = feedback?.tone ?? 'muted';

    this.updateNoSetNotice(noSet);
    this.updateAids(noSet);
  }

  /**
   * Show or hide the "no SET on this board" cover.
   *
   * The board underneath is left visible on purpose — players want to see the
   * position they were beaten by — but it stops taking taps, so nobody spends the
   * pause building a claim that cannot be correct.
   */
  private updateNoSetNotice(pending: boolean): void {
    // Already in the right state: leaving it alone is what keeps the entrance
    // animation from restarting on every 250ms tick.
    if (this.noSetNotice.hidden === !pending) return;
    this.noSetNotice.hidden = !pending;
    // A class, not `inert`: making the board inert would drop the keyboard focus
    // a player had on a card and leave them nowhere when the pause ends. The
    // cards stay focusable and simply refuse to be picked — the store ignores a
    // tap or an Enter on a board that is out of play, and CSS stops the pointer.
    this.board.classList.toggle('board--frozen', pending);
    if (pending && !prefersReducedMotion()) {
      this.noSetNotice.classList.remove('noSetNotice--in');
      void this.noSetNotice.offsetWidth;
      this.noSetNotice.classList.add('noSetNotice--in');
    }
  }

  /**
   * The hint countdowns and the request for more cards.
   *
   * Runs on the same 250ms tick as the cooldown, so both countdowns stay live
   * without a timer of their own.
   */
  private updateAids(noSetPending: boolean): void {
    const room = this.store.getState().room;
    if (!room) return;

    const revealed = this.store.activeHint()?.level ?? 0;
    for (const level of [1, 2] as const) {
      const node = this.hintButtons[level];
      const label = t(`game.hint${level}` as StringKey);
      const seconds = this.store.hintUnlockSeconds(level);
      const used = revealed >= level;
      node.disabled = seconds > 0 || used || noSetPending;
      node.classList.toggle('btn--done', used);
      node.textContent = used
        ? t('game.hintTaken', { label })
        : seconds > 0
          ? t('game.hintLocked', { label, clock: formatClock(seconds) })
          : label;
    }

    const { votes, needed } = this.store.dealProgress();
    const mine = this.store.iWantMoreCards();
    const possible =
      room.deckRemaining >= SET_SIZE && room.board.length + SET_SIZE <= MAX_BOARD_SIZE;
    this.moreButton.disabled = !possible || noSetPending;
    this.moreButton.classList.toggle('btn--waiting', mine);
    // Somebody is waiting on an answer from this player: make it look like a
    // question rather than another idle chip.
    this.moreButton.classList.toggle('btn--asking', votes > 0 && !mine);
    this.moreButton.textContent = mine
      ? t('game.moreCardsWaiting', { votes, needed })
      : votes > 0
        ? t('game.moreCardsAgree', { votes, needed })
        : t('game.moreCards');
  }

  /**
   * Show the set that was just taken. The cards are rebuilt only when a new set
   * arrives, so the strip is not re-created on every unrelated state update.
   */
  private updateLastSet(): void {
    const entry = this.store.getState().lastSet;
    if (!entry) {
      if (this.lastSetId !== -1) {
        this.lastSetId = -1;
        this.lastSet.hidden = true;
        this.feed.hidden = false;
        this.lastSetCards.replaceChildren();
      }
      return;
    }
    if (entry.id === this.lastSetId) return;
    this.lastSetId = entry.id;
    // The feed would only repeat this in words.
    this.feed.hidden = true;
    this.lastSetText.textContent = entry.byMe
      ? t('game.lastSetYou')
      : t('game.lastSet', { name: entry.playerName });
    this.lastSetCards.replaceChildren(...entry.cards.map((id) => createMiniCard(document, id)));
    this.lastSet.hidden = false;
    if (!prefersReducedMotion()) {
      this.lastSet.classList.remove('lastSet--in');
      void this.lastSet.offsetWidth;
      this.lastSet.classList.add('lastSet--in');
    }
  }

  /**
   * The activity feed shows only the newest event, as a single line inside the
   * header. It deliberately does not float over the board: on a 360px screen a
   * stack of toasts hides cards, which is unacceptable in a game about scanning
   * the board.
   */
  private updateFeed(): void {
    const entry = this.store.getState().feed;
    if (!entry) {
      this.feed.textContent = '';
      this.lastFeedId = -1;
      return;
    }
    if (entry.id === this.lastFeedId) return;
    this.lastFeedId = entry.id;
    this.feed.textContent = entry.text;
    this.feed.dataset['tone'] = entry.tone;
    if (!prefersReducedMotion()) {
      this.feed.classList.remove('feed--in');
      void this.feed.offsetWidth;
      this.feed.classList.add('feed--in');
    }
  }

  /**
   * Size the grid so the whole board fits the space available, then hand the
   * numbers to CSS. Recomputed on resize, rotation and every board-size change.
   */
  private updateLayout(): void {
    const count = this.store.getState().room?.board.length ?? 0;
    const wrap = this.board.parentElement;
    if (!wrap || count === 0) return;
    // Nothing useful to measure yet; the ResizeObserver will call back.
    if (wrap.clientWidth === 0 || wrap.clientHeight === 0) return;
    const styles = getComputedStyle(wrap);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const gap = parseFloat(getComputedStyle(this.board).gap) || 10;
    const aspect = parseFloat(styles.getPropertyValue('--card-aspect')) || 0.7;

    const availableWidth = Math.max(wrap.clientWidth - padX, 120);
    const availableHeight = Math.max(wrap.clientHeight - padY, 120);
    const layout = computeLayout({
      availableWidth,
      availableHeight,
      cardCount: count,
      gap,
      aspect,
    });

    // The measured box is part of the key, so a layout computed from a stale or
    // pre-layout measurement is always superseded.
    const key = [
      Math.round(availableWidth),
      Math.round(availableHeight),
      count,
      layout.columns,
      Math.round(layout.cardWidth),
    ].join(':');
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.board.style.setProperty('--card-w', `${layout.cardWidth}px`);
    this.board.style.setProperty('--board-w', `${layout.boardWidth}px`);
    this.board.dataset['columns'] = String(layout.columns);
    wrap.classList.toggle('boardWrap--scrolls', layout.scrolls);
  }

  /**
   * Move a card that has left the board into the ghost layer and let it animate
   * out, so a successful claim reads as "those three go, these three arrive"
   * rather than an instant swap. Honours reduced-motion by removing outright.
   */
  private retireCard(element: HTMLButtonElement): void {
    if (prefersReducedMotion()) {
      element.remove();
      return;
    }
    const cardRect = element.getBoundingClientRect();
    const layerRect = this.ghosts.getBoundingClientRect();
    element.disabled = true;
    element.tabIndex = -1;
    element.setAttribute('aria-hidden', 'true');
    element.classList.add('card--exit');
    element.style.left = `${cardRect.left - layerRect.left}px`;
    element.style.top = `${cardRect.top - layerRect.top}px`;
    element.style.width = `${cardRect.width}px`;
    element.style.height = `${cardRect.height}px`;
    this.ghosts.appendChild(element);
    const remove = (): void => element.remove();
    element.addEventListener('animationend', remove, { once: true });
    // Belt and braces: if the animation never fires, do not leak the node.
    setTimeout(remove, 800);
  }

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */

  /**
   * Leaving mid-game is destructive and the control sits in a tight header, so it
   * takes two taps: the first arms it and relabels the button, and it disarms
   * itself after a few seconds.
   */
  private onLeaveTapped(): void {
    if (this.leaveArmed) {
      this.store.leaveRoom();
      return;
    }
    this.leaveArmed = true;
    this.leaveButton.textContent = t('game.leaveConfirm');
    this.leaveButton.classList.add('btn--armed');
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => this.disarmLeave(), 4_000);
  }

  private disarmLeave(): void {
    this.leaveArmed = false;
    this.leaveButton.textContent = t('game.leave');
    this.leaveButton.classList.remove('btn--armed');
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  private onBoardClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.card');
    if (!target) return;
    const id = Number(target.dataset['cardId']);
    if (!Number.isInteger(id)) return;
    this.store.toggleCard(id);
  }

  private playEffect(effect: Effect): void {
    if (prefersReducedMotion()) return;
    switch (effect.kind) {
      case 'accepted': {
        // The claimed cards are already animating out of the ghost layer; pulse
        // the board so every player sees that a set was taken.
        const pulse = effect.byMe ? 'boardWrap--mine' : 'boardWrap--accepted';
        const wrap = this.board.parentElement;
        if (wrap) {
          wrap.classList.remove('boardWrap--accepted', 'boardWrap--mine');
          void wrap.offsetWidth;
          wrap.classList.add(pulse);
          setTimeout(() => wrap.classList.remove(pulse), 600);
        }
        return;
      }
      case 'rejected':
        for (const id of effect.cards) {
          const element = this.cardElements.get(id);
          if (element) flashCard(element, 'bad');
        }
        return;
      case 'blocked':
        this.board.classList.remove('board--nudge');
        void this.board.offsetWidth;
        this.board.classList.add('board--nudge');
        setTimeout(() => this.board.classList.remove('board--nudge'), 400);
        return;
      default:
        return;
    }
  }
}
