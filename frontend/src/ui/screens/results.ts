/**
 * Results screen.
 *
 * Ranking is by number of successful SET claims, descending. Equal scores are
 * shown as a genuine tie — no invented tie-breaker — and every tied player is
 * listed as a winner.
 */

import { t } from '../../i18n/index.js';
import type { Store } from '../../state/store.js';
import { button, el } from '../dom.js';
import { playerRow } from '../players.js';

export function createResultsScreen(store: Store): HTMLElement {
  const state = store.getState();
  const room = state.room;
  if (!room) return el('div', { class: 'screen' });

  const ranked = store.ranked();
  const best = ranked.length > 0 ? ranked[0]!.score : 0;
  const winners = ranked.filter((player) => player.score === best);
  const iWon = winners.some((player) => player.id === state.meId);

  const headline =
    winners.length > 1
      ? t('results.tie', { names: winners.map((player) => player.name).join(', ') })
      : iWon
        ? t('results.winnerYou')
        : t('results.winner', { name: winners[0]?.name ?? '' });

  const host = room.players.find((player) => player.isHost);
  const connected = room.players.filter((player) => player.connected).length;
  const canRestart = store.isHost() && connected >= room.minPlayers;
  const me = store.me();

  return el('div', {
    class: 'screen screen--results',
    children: [
      el('header', {
        class: 'screen__header',
        children: [
          el('p', { class: 'results__eyebrow', text: t('results.title') }),
          el('h1', {
            class: 'results__headline',
            text: headline,
            attrs: { 'data-testid': 'results-headline' },
          }),
        ],
      }),
      el('section', {
        class: 'panel',
        children: [
          el('ol', {
            class: 'players players--ranked',
            attrs: { 'data-testid': 'final-scores' },
            children: ranked.map((player) => playerRow(player, player.id === state.meId, true)),
          }),
        ],
      }),
      el('div', {
        class: 'screen__footer',
        children: [
          store.isHost()
            ? button(t('results.startRematch'), 'primary', () => store.requestRematch(), {
                disabled: !canRestart,
                class: 'btn--block btn--lg',
                attrs: { 'data-testid': 'rematch' },
              })
            : button(t('results.playAgain'), 'primary', () => store.requestRematch(), {
                disabled: me?.wantsRematch === true,
                class: 'btn--block btn--lg',
                attrs: { 'data-testid': 'rematch' },
              }),
          store.isHost()
            ? connected < room.minPlayers
              ? el('p', {
                  class: 'lobby__hint',
                  text: t('lobby.needMorePlayers', { min: room.minPlayers }),
                })
              : null
            : el('p', {
                class: 'lobby__hint',
                text: t('results.waitingForHost', { name: host?.name ?? '' }),
              }),
          button(t('results.leave'), 'ghost', () => store.leaveRoom(), { class: 'btn--block' }),
        ],
      }),
    ],
  });
}
