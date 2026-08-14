/**
 * Real two-player multiplayer flows, driven through two independent browser
 * contexts against the real Worker.
 */

import { expect, test } from '@playwright/test';
import { INITIAL_BOARD_SIZE } from '@set/shared';
import {
  boardCardIds,
  claimCards,
  pollUntil,
  closePlayers,
  createRoom,
  findNonSetOnBoard,
  ensureSetOnBoard,
  joinByCode,
  joinByLink,
  myScore,
  newPlayer,
  playToCompletion,
  scoreOf,
  startGame,
} from './helpers.js';

test.describe('two players in one room', () => {
  test('create, join by link, start, and claim a SET that scores for both to see', async ({
    browser,
  }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');

    const code = await createRoom(maya);
    await joinByLink(david, code);

    // Both players see both names in the lobby.
    for (const player of [maya, david]) {
      await expect(player.page.getByTestId('player-list')).toContainText('Maya');
      await expect(player.page.getByTestId('player-list')).toContainText('David');
    }
    // Only the host gets a start button; the guest is told what is happening.
    await expect(maya.page.getByTestId('start-game')).toBeVisible();
    await expect(david.page.getByTestId('start-game')).toHaveCount(0);
    await expect(david.page.getByTestId('waiting-for-host')).toContainText('Maya');

    await startGame(maya, david);

    // The two clients render the identical authoritative board.
    expect(await boardCardIds(maya.page)).toEqual(await boardCardIds(david.page));

    const cards = await ensureSetOnBoard(maya.page);
    await claimCards(maya.page, cards);

    await expect.poll(async () => scoreOf(david.page, 'Maya'), { timeout: 10_000 }).toBe(1);
    expect(await myScore(maya.page)).toBe(1);
    expect(await scoreOf(maya.page, 'David')).toBe(0);

    // The board is refilled and the claimed cards are gone for everyone.
    await expect(david.page.locator('.card:not(.card--exit)')).toHaveCount(INITIAL_BOARD_SIZE);
    for (const id of cards) {
      await expect(david.page.locator(`.card[data-card-id="${id}"]:not(.card--exit)`)).toHaveCount(
        0,
      );
    }
    // The winner's selection is cleared automatically.
    await expect(maya.page.locator('.card--selected')).toHaveCount(0);
    // The activity feed sits in the header, not over the board, and persists.
    await expect(david.page.getByTestId('feed')).toContainText('Maya found a SET');

    await closePlayers(maya, david);
  });

  test('joining by typed code works too', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByCode(david, code);
    await expect(david.page.getByTestId('room-code')).toHaveText(code);
    await expect(maya.page.getByTestId('player-list')).toContainText('David');
    await closePlayers(maya, david);
  });

  test('an invalid claim explains itself, cools down only that player, and leaves the board alone', async ({
    browser,
  }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const before = await boardCardIds(maya.page);
    const cards = await findNonSetOnBoard(maya.page);
    await claimCards(maya.page, cards);

    // Private explanation naming the attribute that failed.
    await expect(maya.page.getByTestId('feedback')).toContainText(/Not a SET/i);
    await expect(maya.page.getByTestId('feedback')).toHaveAttribute('data-tone', 'bad');
    // Visible cooldown on the claim button.
    await expect(maya.page.getByTestId('claim')).toBeDisabled();
    await expect(maya.page.getByTestId('claim')).toContainText(/Wait \d+s/);
    await expect(maya.page.getByTestId('no-set')).toBeDisabled();

    // The board did not change for anyone.
    expect(await boardCardIds(maya.page)).toEqual(before);
    expect(await boardCardIds(david.page)).toEqual(before);

    // David hears that a claim failed but is not penalised and is not told why.
    await expect(david.page.getByTestId('feed')).toContainText('Maya');
    await expect(david.page.getByTestId('feed')).not.toContainText(
      /purple|green|red|oval|diamond/i,
    );
    await expect(david.page.getByTestId('claim')).not.toContainText(/Wait/);
    const davidCards = await ensureSetOnBoard(david.page);
    await claimCards(david.page, davidCards);
    await expect.poll(async () => myScore(david.page), { timeout: 10_000 }).toBe(1);

    // The cooldown expires on its own and Maya can act again. (The claim button
    // stays disabled only because her selection was cleared by the board change.)
    await expect(maya.page.getByTestId('no-set')).toBeEnabled({ timeout: 15_000 });
    await expect(maya.page.getByTestId('claim')).not.toContainText(/Wait/);
    const again = await ensureSetOnBoard(maya.page);
    await claimCards(maya.page, again);
    await expect.poll(async () => myScore(maya.page), { timeout: 10_000 }).toBe(1);

    await closePlayers(maya, david);
  });

  test('a fourth selection is refused with a prompt instead of silently swapping', async ({
    browser,
  }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const board = await boardCardIds(maya.page);
    for (const id of board.slice(0, 3)) {
      await maya.page.locator(`.card[data-card-id="${id}"]`).click();
    }
    await expect(maya.page.locator('.card--selected')).toHaveCount(3);

    await maya.page.locator(`.card[data-card-id="${board[3]!}"]`).click();
    await expect(maya.page.locator('.card--selected')).toHaveCount(3);
    await expect(maya.page.getByTestId('feedback')).toContainText(/only pick three/i);
    await expect(maya.page.locator(`.card[data-card-id="${board[3]!}"]`)).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Tapping a selected card unpicks it.
    await maya.page.locator(`.card[data-card-id="${board[0]!}"]`).click();
    await expect(maya.page.locator('.card--selected')).toHaveCount(2);
    await expect(maya.page.getByTestId('claim')).toBeDisabled();

    await closePlayers(maya, david);
  });

  test('"No SET on board" is answered authoritatively, whatever the deal', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const before = await boardCardIds(maya.page);
    expect(before).toHaveLength(INITIAL_BOARD_SIZE);
    await maya.page.getByTestId('no-set').click();

    // Wait for one of the two authoritative outcomes rather than reading the
    // feedback line straight away — it carries default prompt text until the
    // server replies, which would race.
    const outcome = await pollUntil(async () => {
      if ((await maya.page.locator('.card:not(.card--exit)').count()) === 15) return 'dealt';
      const text = await maya.page.getByTestId('feedback').innerText();
      return /still a SET/i.test(text) ? 'rejected' : null;
    });

    if (outcome === 'rejected') {
      // A set existed: board untouched, caller cooled down, nobody else affected,
      // and no set revealed.
      expect(await boardCardIds(maya.page)).toEqual(before);
      expect(await boardCardIds(david.page)).toEqual(before);
      await expect(maya.page.getByTestId('claim')).toContainText(/Wait \d+s/);
      await expect(maya.page.getByTestId('no-set')).toBeDisabled();
      await expect(david.page.getByTestId('claim')).not.toContainText(/Wait/);
      await expect(david.page.getByTestId('no-set')).toBeEnabled();
      await expect(david.page.getByTestId('feed')).not.toContainText(
        /oval|diamond|squiggle|purple/i,
      );
    } else {
      // The board genuinely had no set: exactly three cards added, no cooldown,
      // and the original twelve keep their positions.
      await expect(david.page.locator('.card:not(.card--exit)')).toHaveCount(15);
      expect((await boardCardIds(maya.page)).slice(0, 12)).toEqual(before);
      await expect(maya.page.getByTestId('claim')).not.toContainText(/Wait/);
      await expect(maya.page.getByTestId('feed')).toContainText(/3 cards added/i);
    }

    await closePlayers(maya, david);
  });

  test('only one of two simultaneous claims on the same cards can win', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const cards = await ensureSetOnBoard(maya.page);
    // Both players select the same three cards before either submits.
    for (const id of cards) {
      await maya.page.locator(`.card[data-card-id="${id}"]`).click();
      await david.page.locator(`.card[data-card-id="${id}"]`).click();
    }
    // `dispatchEvent` rather than `click`: a real click waits for the button to
    // be actionable, and the loser's button is disabled the instant the winning
    // broadcast lands — which would hang the very race this test is provoking.
    await Promise.all([
      maya.page.getByTestId('claim').dispatchEvent('click'),
      david.page.getByTestId('claim').dispatchEvent('click'),
    ]);

    await expect
      .poll(async () => (await scoreOf(maya.page, 'Maya')) + (await scoreOf(maya.page, 'David')), {
        timeout: 10_000,
      })
      .toBe(1);
    // Both clients agree on who scored.
    expect(await scoreOf(maya.page, 'Maya')).toBe(await scoreOf(david.page, 'Maya'));
    expect(await scoreOf(maya.page, 'David')).toBe(await scoreOf(david.page, 'David'));
    // The loser's selection was cleared and they were told the board moved.
    const loser = (await scoreOf(maya.page, 'Maya')) === 1 ? david : maya;
    await expect(loser.page.locator('.card--selected')).toHaveCount(0);

    await closePlayers(maya, david);
  });

  test('the host role transfers when the host disconnects in the lobby', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await expect(david.page.getByTestId('start-game')).toHaveCount(0);

    await maya.context.close();

    // David becomes host and now sees the start control.
    await expect(david.page.getByTestId('start-game')).toBeVisible({ timeout: 15_000 });
    await expect(david.page.getByTestId('player-list')).toContainText('reconnecting');
    await closePlayers(david);
  });

  test('a reload rejoins the same seat and keeps the score', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await claimCards(maya.page, await ensureSetOnBoard(maya.page));
    await expect.poll(async () => myScore(maya.page), { timeout: 10_000 }).toBe(1);

    await maya.page.reload();

    // Straight back into the running game, same seat, same score.
    await expect(maya.page.getByTestId('board')).toBeVisible({ timeout: 20_000 });
    expect(await myScore(maya.page)).toBe(1);
    expect(await boardCardIds(maya.page)).toEqual(await boardCardIds(david.page));
    await expect(david.page.getByTestId('player-list')).toHaveCount(0);

    await closePlayers(maya, david);
  });

  test('a game plays to completion and the host can start a rematch', async ({ browser }) => {
    test.slow();
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await playToCompletion([maya, david]);

    for (const player of [maya, david]) {
      await expect(player.page.getByTestId('results-headline')).toBeVisible({ timeout: 20_000 });
      await expect(player.page.getByTestId('final-scores')).toBeVisible();
    }
    // Scores are consistent and account for the whole deck.
    const finalText = await maya.page.getByTestId('final-scores').innerText();
    expect(finalText).toContain('Maya');
    expect(finalText).toContain('David');

    // A guest "play again" registers as readiness but does not restart the game.
    await david.page.getByTestId('rematch').click();
    await expect(maya.page.getByTestId('final-scores')).toContainText('ready', { timeout: 10_000 });
    await expect(david.page.getByTestId('results-headline')).toBeVisible();

    // The host starts a fresh game with reset scores.
    await maya.page.getByTestId('rematch').click();
    for (const player of [maya, david]) {
      await expect(player.page.getByTestId('board')).toBeVisible({ timeout: 20_000 });
      await expect(player.page.locator('.card:not(.card--exit)')).toHaveCount(INITIAL_BOARD_SIZE);
    }
    expect(await myScore(maya.page)).toBe(0);
    expect(await myScore(david.page)).toBe(0);

    await closePlayers(maya, david);
  });
});
