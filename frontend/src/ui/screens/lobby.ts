/**
 * Lobby: get people into the room, then start.
 *
 * The invite block mirrors the owner's SuperTaki project so the two games feel
 * the same: the code big enough to read out, a QR of the invite link beside it
 * for a phone that is already in the room, then Copy code / Copy link / Share,
 * each confirming on the button itself. The long URL nobody types by hand stays
 * folded away behind a disclosure.
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

export function createLobbyScreen(store: Store): HTMLElement {
  const state = store.getState();
  const room = state.room;
  if (!room) return el('div', { class: 'screen' });

  const host = room.players.find((player) => player.isHost);
  const connected = room.players.filter((player) => player.connected).length;
  const canStart = store.isHost() && connected >= room.minPlayers;
  const inviteUrl = joinUrl(room.code);

  const note = el('p', { class: 'invite__note', attrs: { role: 'status' } });

  /** Copy, then say so on the button that was pressed. */
  const copyButton = (
    label: string,
    value: string,
    testId: string,
    variant: 'secondary' | 'ghost',
  ): HTMLButtonElement => {
    const node = button(
      label,
      variant,
      () => {
        void copyText(value).then((ok) => {
          if (!ok) {
            note.textContent = t('lobby.shareUnavailable');
            return;
          }
          note.textContent = '';
          node.textContent = t('common.copied');
          node.classList.add('btn--done');
          setTimeout(() => {
            node.textContent = label;
            node.classList.remove('btn--done');
          }, COPIED_FOR_MS);
        });
      },
      { attrs: { 'data-testid': testId } },
    );
    return node;
  };

  const actions: HTMLElement[] = [
    copyButton(t('common.copyCode'), room.code, 'copy-code', 'secondary'),
    copyButton(t('common.copyLink'), inviteUrl, 'copy-link', 'secondary'),
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
            text: t('lobby.shareText', { code: room.code }),
            url: inviteUrl,
          }).then((ok) => {
            if (!ok) note.textContent = t('lobby.shareUnavailable');
          });
        },
        { attrs: { 'data-testid': 'share-room' } },
      ),
    );
  }

  const qr = createQrCode(document, inviteUrl, t('lobby.qrLabel', { room: room.code }));

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
                text: room.code,
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
      note,
      el('details', {
        class: 'disclosure',
        children: [
          el('summary', { text: t('lobby.inviteLink') }),
          el('span', { class: 'invite__url', text: inviteUrl }),
        ],
      }),
    ],
  });

  const waiting = store.isHost()
    ? connected < room.minPlayers
      ? el('p', {
          class: 'lobby__hint',
          text: t('lobby.needMorePlayers', { min: room.minPlayers }),
        })
      : null
    : el('p', {
        class: 'lobby__hint',
        attrs: { 'data-testid': 'waiting-for-host' },
        text: t('lobby.waitingForHost', { name: host?.name ?? '' }),
      });

  return el('div', {
    class: 'screen screen--lobby',
    children: [
      el('header', {
        class: 'screen__header',
        children: [
          el('h1', { class: 'screen__title', text: t('lobby.title', { code: room.code }) }),
        ],
      }),
      invite,
      el('section', {
        class: 'panel',
        children: [
          el('h2', {
            class: 'panel__title',
            text: t('lobby.players', { count: room.players.length, max: room.maxPlayers }),
          }),
          el('ul', {
            class: 'players',
            attrs: { 'data-testid': 'player-list' },
            children: room.players.map((player) =>
              playerRow(player, player.id === state.meId, false),
            ),
          }),
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
          waiting,
          store.isHost()
            ? button(t('lobby.start'), 'primary', () => store.startGame(), {
                disabled: !canStart,
                class: 'btn--block btn--lg',
                attrs: { 'data-testid': 'start-game' },
              })
            : null,
          button(t('lobby.leave'), 'ghost', () => store.leaveRoom(), { class: 'btn--block' }),
        ],
      }),
    ],
  });
}
