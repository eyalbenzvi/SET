/**
 * Lobby: get people into the room, then start.
 *
 * The invite block mirrors the owner's SuperTaki project so the two games feel
 * the same: the code big enough to read out, a QR of the invite link beside it
 * for a phone that is already in the room, then Copy code / Copy link / Share,
 * each confirming on the button itself. The long URL nobody types by hand stays
 * folded away behind a disclosure.
 *
 * Like the home and game screens this is a **persistent component**, and for the
 * same reason: rebuilding it on every state change — a player joining, a toast
 * expiring — would wipe the "Copied" confirmation off the button, collapse the
 * open disclosure, and drop focus. Built once; only the roster and footer are
 * patched.
 */

import { t } from '../../i18n/index.js';
import { joinUrl } from '../../config.js';
import type { Store } from '../../state/store.js';
import { button, el } from '../dom.js';
import { playerRow } from '../players.js';
import { canShare, copyText, shareLink } from '../../lib/share.js';
import { createQrCode } from '../qr.js';

/** How long "Copied" stays on a button before it offers to copy again. */
const COPIED_FOR_MS = 1_600;

export class LobbyScreen {
  readonly root: HTMLElement;
  /** The room this screen was built for; a different room needs a new screen. */
  readonly code: string;
  private readonly note: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly playersTitle: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly startButton: HTMLButtonElement | null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: Store,
    code: string,
  ) {
    this.code = code;
    const inviteUrl = joinUrl(code);

    this.note = el('p', { class: 'invite__note', attrs: { role: 'status' } });

    const actions: HTMLElement[] = [
      this.copyButton(t('common.copyCode'), code, 'copy-code'),
      this.copyButton(t('common.copyLink'), inviteUrl, 'copy-link'),
    ];
    // The platform share sheet, only where the browser actually has one.
    if (canShare()) {
      actions.push(
        button(
          t('common.share'),
          'primary',
          () => {
            void shareLink({
              title: t('app.title'),
              text: t('lobby.shareText', { code }),
              url: inviteUrl,
            }).then((ok) => {
              if (!ok) this.note.textContent = t('lobby.shareUnavailable');
            });
          },
          { attrs: { 'data-testid': 'share-room' } },
        ),
      );
    }

    const qr = createQrCode(document, inviteUrl, t('lobby.qrLabel', { room: code }));

    const invite = el('section', {
      class: 'panel invite',
      children: [
        el('h2', { class: 'panel__title', text: t('lobby.inviteTitle') }),
        el('p', { class: 'invite__body', text: t('lobby.inviteBody') }),
        el('div', {
          class: 'invite__ways',
          children: [
            el('p', {
              class: 'roomCode',
              children: [
                el('span', { class: 'roomCode__label', text: t('home.codeLabel') }),
                el('strong', {
                  class: 'roomCode__value',
                  text: code,
                  attrs: { 'data-testid': 'room-code' },
                }),
              ],
            }),
            qr
              ? el('figure', {
                  class: 'qrFigure',
                  children: [
                    el('span', { class: 'qrFigure__plate', children: [qr] }),
                    el('figcaption', { class: 'qrFigure__caption', text: t('lobby.qrCaption') }),
                  ],
                })
              : null,
          ],
        }),
        el('div', { class: 'invite__actions', children: actions }),
        this.note,
        el('details', {
          class: 'disclosure',
          children: [
            el('summary', { text: t('lobby.inviteLink') }),
            el('span', { class: 'invite__url', text: inviteUrl }),
          ],
        }),
      ],
    });

    this.playersTitle = el('h2', { class: 'panel__title' });
    this.playerList = el('ul', { class: 'players', attrs: { 'data-testid': 'player-list' } });
    this.hint = el('p', { class: 'lobby__hint' });

    // Only the host gets a start control, and host is settled before the lobby
    // is built; a host handover re-creates the screen (see `App.render`).
    this.startButton = store.isHost()
      ? button(t('lobby.start'), 'primary', () => store.startGame(), {
          class: 'btn--block btn--lg',
          attrs: { 'data-testid': 'start-game' },
        })
      : null;

    this.root = el('div', {
      class: 'screen screen--lobby',
      children: [
        el('header', {
          class: 'screen__header',
          children: [el('h1', { class: 'screen__title', text: t('lobby.title', { code }) })],
        }),
        invite,
        el('section', {
          class: 'panel',
          children: [
            this.playersTitle,
            this.playerList,
            // Players kept asking whose turn it was, so the answer is stated here
            // rather than only in the rules sheet.
            el('div', {
              class: 'notice',
              children: [
                el('strong', { class: 'notice__title', text: t('lobby.noTurns') }),
                el('span', { class: 'notice__body', text: t('lobby.noTurnsBody') }),
              ],
            }),
          ],
        }),
        el('div', {
          class: 'screen__footer',
          children: [
            this.hint,
            this.startButton,
            button(t('lobby.leave'), 'ghost', () => store.leaveRoom(), { class: 'btn--block' }),
          ],
        }),
      ],
    });
  }

  /**
   * A copy button that confirms on itself, then reverts.
   *
   * The confirmation appears on the tap, not when the clipboard promise settles.
   * `navigator.clipboard.writeText` can stay pending indefinitely when the
   * document is not focused, and waiting on it left the button completely silent
   * — no confirmation and no error. Only an outright failure walks it back.
   */
  private copyButton(label: string, value: string, testId: string): HTMLButtonElement {
    const revert = (node: HTMLButtonElement): void => {
      node.textContent = label;
      node.classList.remove('btn--done');
    };
    const node: HTMLButtonElement = button(
      label,
      'secondary',
      () => {
        this.note.textContent = '';
        node.textContent = t('common.copied');
        node.classList.add('btn--done');
        const timer = setTimeout(() => {
          revert(node);
          this.timers.delete(timer);
        }, COPIED_FOR_MS);
        this.timers.add(timer);

        void copyText(value).then((ok) => {
          if (ok) return;
          clearTimeout(timer);
          this.timers.delete(timer);
          revert(node);
          this.note.textContent = t('lobby.shareUnavailable');
        });
      },
      { attrs: { 'data-testid': testId } },
    );
    return node;
  }

  /** Patch the roster and the footer. Never rebuilds the invite block. */
  update(): void {
    const state = this.store.getState();
    const room = state.room;
    if (!room) return;

    this.playersTitle.textContent = t('lobby.players', {
      count: room.players.length,
      max: room.maxPlayers,
    });
    this.playerList.replaceChildren(
      ...room.players.map((player) => playerRow(player, player.id === state.meId, false)),
    );

    const connected = room.players.filter((player) => player.connected).length;
    const enough = connected >= room.minPlayers;
    if (this.startButton) {
      this.startButton.disabled = !enough;
      this.hint.textContent = enough ? '' : t('lobby.needMorePlayers', { min: room.minPlayers });
      this.hint.removeAttribute('data-testid');
    } else {
      const host = room.players.find((player) => player.isHost);
      this.hint.textContent = t('lobby.waitingForHost', { name: host?.name ?? '' });
      this.hint.dataset['testid'] = 'waiting-for-host';
    }
  }

  /** Cancel pending label reverts when the screen goes away. */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
