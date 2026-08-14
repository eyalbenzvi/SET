/**
 * Shared player row, used by the lobby list and the results table.
 *
 * Names arrive from other players, so they are only ever written with
 * `textContent`.
 */

import type { PublicPlayer } from '@set/shared';
import { t } from '../i18n/index.js';
import { el } from './dom.js';

export function playerRow(player: PublicPlayer, isMe: boolean, showScore: boolean): HTMLElement {
  const tags: HTMLElement[] = [];
  if (player.isHost) tags.push(el('span', { class: 'tag tag--host', text: t('common.host') }));
  if (isMe) tags.push(el('span', { class: 'tag tag--you', text: t('common.you') }));
  if (!player.connected) {
    tags.push(el('span', { class: 'tag tag--offline', text: t('lobby.disconnected') }));
  }
  if (player.wantsRematch) {
    tags.push(el('span', { class: 'tag tag--ready', text: t('results.wantsRematch') }));
  }

  return el('li', {
    class: `players__row${player.connected ? '' : ' players__row--offline'}`,
    attrs: { 'data-player-name': player.name },
    children: [
      el('span', { class: 'players__dot', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'players__name', text: player.name }),
      el('span', { class: 'players__tags', children: tags }),
      showScore
        ? el('span', {
            class: 'players__score',
            text: t('results.setsFound', { count: player.score }),
          })
        : null,
    ],
  });
}
