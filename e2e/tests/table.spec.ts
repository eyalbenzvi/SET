/**
 * The three things a table asks for once it has played a few rounds:
 *
 *  - more cards, when everybody agrees the position is stuck,
 *  - a hint, once a board has resisted for half a minute,
 *  - and a look at the SET somebody else just took.
 *
 * The hint test really does wait out the two unlock timers rather than reaching
 * into the clock: the delays are server-side, and the point of the test is that
 * a player who waits gets a hint that marks cards which really are part of a SET.
 */

import { expect, test } from '@playwright/test';
import { HINT_LEVEL_1_AFTER_MS, HINT_LEVEL_2_AFTER_MS, findAllSetsByIds } from '@set/shared';
import {
  boardCardIds,
  claimCards,
  closePlayers,
  createRoom,
  ensureSetOnBoard,
  joinByLink,
  newPlayer,
  startGame,
} from './helpers.js';

test.describe('more cards by agreement', () => {
  test('one player asking changes nothing; both asking deals three', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);
    // A dead opening board deals itself three cards, which would cancel the very
    // request this test is making. Wait for a board that is actually playable.
    await ensureSetOnBoard(maya.page);

    const more = maya.page.getByTestId('more-cards');
    await expect(more).toHaveText('+3 cards');
    await more.click();

    // Maya is now waiting on the table, and David is asked to agree.
    await expect(more).toHaveText('Waiting 1/2');
    await expect(david.page.getByTestId('more-cards')).toHaveText('Agree? 1/2');
    // Nothing has been dealt on the strength of one request.
    await expect(maya.page.locator('.card')).toHaveCount(12);
    await expect(david.page.locator('.card')).toHaveCount(12);

    await david.page.screenshot({ path: `screenshots/${testInfo.project.name}-deal-vote.png` });

    await david.page.getByTestId('more-cards').click();
    for (const player of [maya, david]) {
      await expect(player.page.locator('.card')).toHaveCount(15);
      // The request is spent, so the button offers a fresh one.
      await expect(player.page.getByTestId('more-cards')).toHaveText('+3 cards');
    }
    // Nobody was punished for asking: a cooldown would be counting down on the
    // claim button, and neither player has one.
    await expect(maya.page.getByTestId('claim')).not.toContainText(/Wait/);
    await expect(david.page.getByTestId('claim')).not.toContainText(/Wait/);
    await closePlayers(maya, david);
  });

  test('a request can be taken back, and a claim cancels it', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);
    await ensureSetOnBoard(maya.page);

    const mine = maya.page.getByTestId('more-cards');
    await mine.click();
    await expect(mine).toHaveText('Waiting 1/2');
    await mine.click();
    await expect(mine).toHaveText('+3 cards');
    await expect(david.page.getByTestId('more-cards')).toHaveText('+3 cards');

    // Ask again, then let David claim a set instead: the request goes with the board.
    await mine.click();
    await expect(david.page.getByTestId('more-cards')).toHaveText('Agree? 1/2');
    const cards = await ensureSetOnBoard(david.page);
    await claimCards(david.page, cards);
    await expect(david.page.getByTestId('more-cards')).toHaveText('+3 cards');
    await expect(mine).toHaveText('+3 cards');
    await expect(maya.page.locator('.card')).toHaveCount(12);
    await closePlayers(maya, david);
  });
});

test.describe('the set that was just taken', () => {
  test('is shown to the other players, in cards', async ({ browser }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const cards = await ensureSetOnBoard(david.page);
    await claimCards(david.page, cards);

    // Maya did not see it happen, so the three cards are spelled out for her.
    const strip = maya.page.getByTestId('last-set');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('David took');
    const shown = await strip
      .locator('.miniCard')
      .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset['cardId'])));
    expect(shown).toEqual(cards);
    // Each one is described, so this is not a colour-only cue.
    await expect(strip.locator('.miniCard').first()).toHaveAttribute('aria-label', /.+/);

    // The claimer sees it too, phrased as their own.
    await expect(david.page.getByTestId('last-set')).toContainText('You took');

    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-last-set.png` });
    await closePlayers(maya, david);
  });
});

test.describe('hints', () => {
  // Two real unlock timers, one after the other, plus setup.
  test.slow();

  test('unlock on the clock and mark cards that really are part of a SET', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const hint1 = maya.page.getByTestId('hint-1');
    const hint2 = maya.page.getByTestId('hint-2');
    // Both start locked, counting down, and saying so on the button.
    await expect(hint1).toBeDisabled();
    await expect(hint2).toBeDisabled();
    // Hint 2 starts a minute out and reads "1:00"; below that, plain seconds.
    await expect(hint1).toHaveText(/^Hint 1 · (1:00|\d{1,2})$/);
    await expect(hint2).toHaveText(/^Hint 2 · (1:00|\d{1,2})$/);

    // Make sure this board has a set to point at, then leave it alone so the
    // clock runs on the position the players are actually looking at.
    await ensureSetOnBoard(maya.page);

    await expect(hint1).toBeEnabled({ timeout: HINT_LEVEL_1_AFTER_MS + 15_000 });
    await expect(hint2).toBeDisabled();
    await hint1.click();

    const marked = maya.page.locator('.card--hinted');
    await expect(marked).toHaveCount(1);
    const board = await boardCardIds(maya.page);
    const firstMarked = Number(await marked.getAttribute('data-card-id'));
    expect(findAllSetsByIds(board).some((set) => set.includes(firstMarked))).toBe(true);
    // Used up on this board, and it is a hint rather than a selection.
    await expect(hint1).toBeDisabled();
    await expect(hint1).toHaveText('Hint 1 ✓');
    await expect(marked).toHaveAttribute('aria-pressed', 'false');
    await expect(marked).toHaveAttribute('aria-label', /marked by a hint/);

    // David is told a hint was taken, but never which card it was.
    await expect(david.page.getByTestId('feed')).toContainText('Maya took a hint');
    await expect(david.page.locator('.card--hinted')).toHaveCount(0);

    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-hint.png` });

    // The second level opens 30 seconds later and marks two cards, which between
    // them determine the third.
    await expect(hint2).toBeEnabled({
      timeout: HINT_LEVEL_2_AFTER_MS - HINT_LEVEL_1_AFTER_MS + 20_000,
    });
    await hint2.click();
    await expect(maya.page.locator('.card--hinted')).toHaveCount(2);
    const two = await maya.page
      .locator('.card--hinted')
      .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset['cardId'])));
    const sets = findAllSetsByIds(await boardCardIds(maya.page));
    expect(sets.some((set) => two.every((id) => set.includes(id)))).toBe(true);
    await closePlayers(maya, david);
  });

  test('a hint is dropped as soon as the board changes', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await ensureSetOnBoard(maya.page);
    const hint1 = maya.page.getByTestId('hint-1');
    await expect(hint1).toBeEnabled({ timeout: HINT_LEVEL_1_AFTER_MS + 15_000 });
    await hint1.click();
    await expect(maya.page.locator('.card--hinted')).toHaveCount(1);

    // David takes a set: the marks described the old board, so they go.
    const cards = await ensureSetOnBoard(david.page);
    await claimCards(david.page, cards);
    await expect(maya.page.locator('.card--hinted')).toHaveCount(0);
    // ...and the clock starts again from the top.
    await expect(hint1).toBeDisabled();
    await expect(hint1).toHaveText(/^Hint 1 · \d{1,2}$/);
    await closePlayers(maya, david);
  });
});
