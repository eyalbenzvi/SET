/**
 * Larger-group behaviour: four independent browsers in one room.
 *
 * The two-player suite covers the core flows; this one checks the things that
 * only show up with a crowd — that every client converges on the same board, that
 * scores fan out to everyone, that the score strip stays usable, and that host
 * succession works mid-game.
 */

import { expect, test } from '@playwright/test';
import { INITIAL_BOARD_SIZE } from '@set/shared';
import {
  boardCardIds,
  claimCards,
  closePlayers,
  createRoom,
  ensureSetOnBoard,
  expectNoHorizontalScroll,
  joinByLink,
  newPlayer,
  scoreOf,
  startGame,
  type PlayerSession,
} from './helpers.js';

const NAMES = ['Maya', 'David', 'Noa', 'Yonatan'];

test.describe('four players in one room', () => {
  test('everyone converges on the same board and sees every score', async ({ browser }) => {
    test.slow();
    const players: PlayerSession[] = [];
    for (const name of NAMES) players.push(await newPlayer(browser, name));
    const [host, ...guests] = players as [PlayerSession, ...PlayerSession[]];

    const code = await createRoom(host);
    for (const guest of guests) await joinByLink(guest, code);

    // Every client lists all four players before the game starts.
    for (const player of players) {
      for (const name of NAMES) {
        await expect(player.page.getByTestId('player-list')).toContainText(name);
      }
    }
    // Exactly one host.
    for (const player of players) {
      await expect(player.page.locator('.tag--host')).toHaveCount(1);
    }

    await startGame(host, ...guests);

    // All four clients render the identical authoritative board.
    const reference = await boardCardIds(host.page);
    expect(reference).toHaveLength(INITIAL_BOARD_SIZE);
    for (const guest of guests) {
      expect(await boardCardIds(guest.page)).toEqual(reference);
    }

    // Four score chips fit without the page scrolling sideways.
    for (const player of players) {
      await expect(player.page.getByTestId('score-chip')).toHaveCount(4);
      await expectNoHorizontalScroll(player.page);
    }

    // A claim by one guest is reflected for everyone.
    const scorer = guests[0]!;
    await claimCards(scorer.page, await ensureSetOnBoard(scorer.page));
    for (const player of players) {
      await expect.poll(async () => scoreOf(player.page, scorer.name), { timeout: 10_000 }).toBe(1);
      for (const other of NAMES.filter((name) => name !== scorer.name)) {
        expect(await scoreOf(player.page, other)).toBe(0);
      }
    }
    // And the boards stay in agreement afterwards.
    const after = await boardCardIds(host.page);
    for (const guest of guests) expect(await boardCardIds(guest.page)).toEqual(after);

    await closePlayers(...players);
  });

  test('the host role moves on mid-game and the new host can run the rematch', async ({
    browser,
  }) => {
    test.slow();
    const players: PlayerSession[] = [];
    for (const name of NAMES.slice(0, 3)) players.push(await newPlayer(browser, name));
    const [host, second, third] = players as [PlayerSession, PlayerSession, PlayerSession];

    const code = await createRoom(host);
    await joinByLink(second, code);
    await joinByLink(third, code);
    await startGame(host, second, third);

    // The host walks away mid-game.
    await host.context.close();

    // The remaining players see them drop out and carry on playing.
    for (const player of [second, third]) {
      await expect(player.page.locator('.scoreChip--offline')).toHaveCount(1, { timeout: 20_000 });
      await expect(player.page.getByTestId('board')).toBeVisible();
    }
    await claimCards(second.page, await ensureSetOnBoard(second.page));
    await expect.poll(async () => scoreOf(third.page, 'David'), { timeout: 10_000 }).toBe(1);

    // Leaving mid-game takes two taps, so a mis-tap cannot drop you out.
    const leave = second.page.getByTestId('leave-game');
    await leave.click();
    await expect(leave).toContainText(/tap again/i);
    await expect(second.page.getByTestId('board')).toBeVisible();
    await leave.click();
    await expect(second.page.getByTestId('create-game')).toBeVisible({ timeout: 10_000 });

    await closePlayers(second, third);
  });
});
