/**
 * Lobby: share the room, see who is in, and (for the host) start the game.
 */

import { t } from '../../i18n/index.js';
import { joinUrl } from '../../config.js';
import type { Store } from '../../state/store.js';
import { button, el } from '../dom.js';
import { playerRow } from '../players.js';

/**
 * Share the join link with the platform sheet when available, otherwise copy it.
 * Both paths end in visible confirmation — a share action that looks like it did
 * nothing is worse than no share action.
 */
async function share(store: Store, code: string): Promise<void> {
  const url = joinUrl(code);
  const text = t('lobby.shareText', { code });
  const nav = globalThis.navigator as Navigator & {
    share?: (data: { title: string; text: string; url: string }) => Promise<void>;
  };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: t('app.title'), text, url });
      return;
    } catch {
      // Cancelled or unsupported in this context; fall through to copying.
    }
  }
  try {
    await nav.clipboard?.writeText(url);
    store.confirmShare();
  } catch {
    store.confirmShare();
  }
}

export function createLobbyScreen(store: Store): HTMLElement {
  const state = store.getState();
  const room = state.room;
  if (!room) return el('div', { class: 'screen' });

  const host = room.players.find((player) => player.isHost);
  const connected = room.players.filter((player) => player.connected).length;
  const canStart = store.isHost() && connected >= room.minPlayers;

  const codeBlock = el('div', {
    class: 'roomCode',
    children: [
      el('span', { class: 'roomCode__label', text: t('home.codeLabel') }),
      el('strong', {
        class: 'roomCode__value',
        text: room.code,
        attrs: { 'data-testid': 'room-code' },
      }),
    ],
  });

  const shareRow = el('div', {
    class: 'lobby__actions',
    children: [
      button(t('lobby.share'), 'primary', () => void share(store, room.code), {
        class: 'btn--block',
        attrs: { 'data-testid': 'share-room' },
      }),
      el('p', {
        class: 'lobby__copied',
        attrs: { role: 'status' },
        text: state.shareConfirmed ? t('common.copied') : '',
      }),
    ],
  });

  const list = el('ul', {
    class: 'players',
    attrs: { 'data-testid': 'player-list' },
    children: room.players.map((player) => playerRow(player, player.id === state.meId, false)),
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
          codeBlock,
        ],
      }),
      shareRow,
      el('section', {
        class: 'panel',
        children: [
          el('h2', {
            class: 'panel__title',
            text: t('lobby.players', { count: room.players.length, max: room.maxPlayers }),
          }),
          list,
          el('p', { class: 'lobby__note', text: t('lobby.hint') }),
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
