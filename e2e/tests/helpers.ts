/**
 * Shared page-object helpers for the multiplayer end-to-end tests.
 *
 * The tests read the board straight out of the DOM (`data-card-id`) and compute
 * a valid SET with the same rules engine the server uses. That means no debug
 * hooks, cheat endpoints or seeded-deck backdoors exist in the shipped build.
 */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { findFirstSet, isSetByIds, type CardId } from '@set/shared';

export interface PlayerSession {
  context: BrowserContext;
  page: Page;
  name: string;
}

/**
 * Open a fresh browser context (its own localStorage) for one player.
 *
 * The app defaults to Hebrew. These suites assert on English wording, so the
 * locale is pinned here through the same localStorage key the language switch
 * writes — `locale.spec.ts` covers the Hebrew default and the switch itself.
 */
export async function newPlayer(
  browser: Browser,
  name: string,
  locale: 'en' | 'he' | null = 'en',
): Promise<PlayerSession> {
  const context = await browser.newContext();
  if (locale) {
    await context.addInitScript((value: string) => {
      window.localStorage.setItem('set.locale', value);
    }, locale);
  }
  const page = await context.newPage();
  return { context, page, name };
}

export async function closePlayers(...players: PlayerSession[]): Promise<void> {
  for (const player of players) await player.context.close();
}

/** Create a room as `player` and return the room code shown in the lobby. */
export async function createRoom(player: PlayerSession): Promise<string> {
  await player.page.goto('./');
  await player.page.getByTestId('create-game').click();
  await player.page.locator('#player-name').fill(player.name);
  await player.page.getByTestId('submit-name').click();
  const code = await player.page.getByTestId('room-code').innerText();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  return code.trim();
}

/** Join an existing room using the share link. */
export async function joinByLink(player: PlayerSession, code: string): Promise<void> {
  await player.page.goto(`./#room=${code}`);
  // The code arrives pre-filled from the link.
  await expect(player.page.locator('#room-code')).toHaveValue(code);
  await player.page.locator('#player-name').fill(player.name);
  await player.page.getByTestId('submit-name').click();
  await expect(player.page.getByTestId('room-code')).toHaveText(code);
}

/** Join an existing room by typing the code on the home screen. */
export async function joinByCode(player: PlayerSession, code: string): Promise<void> {
  await player.page.goto('./');
  await player.page.getByTestId('join-game').click();
  await player.page.locator('#room-code').fill(code);
  await player.page.locator('#player-name').fill(player.name);
  await player.page.getByTestId('submit-name').click();
}

/** Host starts the game; both pages wait until the board is visible. */
export async function startGame(host: PlayerSession, ...others: PlayerSession[]): Promise<void> {
  const startButton = host.page.getByTestId('start-game');
  await expect(startButton).toBeEnabled();
  await startButton.click();
  for (const player of [host, ...others]) {
    await expect(player.page.getByTestId('board')).toBeVisible();
    await expect(player.page.locator('.card')).toHaveCount(12);
  }
}

/** Card ids currently face-up, in board order. */
export async function boardCardIds(page: Page): Promise<CardId[]> {
  const values = await page
    .locator('.card:not(.card--exit)')
    .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset['cardId'])));
  return values.filter((value) => Number.isInteger(value));
}

/**
 * A valid SET on the current board, computed by the shared rules engine.
 *
 * About one deal in thirty contains no set at all, so this resolves that
 * position exactly as a player would — by calling "No SET on board" until three
 * more cards produce one.
 */
export async function ensureSetOnBoard(page: Page): Promise<CardId[]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const board = await boardCardIds(page);
    const found = findFirstSet(board);
    if (found) return [...found];
    const noSet = page.getByTestId('no-set');
    await expect(noSet).toBeEnabled();
    await noSet.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.card:not(.card--exit)').length > previous,
      board.length,
      { timeout: 10_000 },
    );
  }
  throw new Error('could not reach a board containing a set');
}

/**
 * Poll `probe` until it returns something other than `null`.
 *
 * Used where a test must wait for one of several authoritative outcomes rather
 * than assert on a single element, which would race with the server reply.
 */
export async function pollUntil<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error('timed out waiting for an outcome');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Three face-up cards that are definitely not a SET. */
export async function findNonSetOnBoard(page: Page): Promise<CardId[]> {
  const board = await boardCardIds(page);
  for (let i = 0; i < board.length; i++) {
    for (let j = i + 1; j < board.length; j++) {
      for (let k = j + 1; k < board.length; k++) {
        if (!isSetByIds(board[i]!, board[j]!, board[k]!)) return [board[i]!, board[j]!, board[k]!];
      }
    }
  }
  throw new Error('no non-set triple on board');
}

/** Tap three cards and submit the claim. */
export async function claimCards(page: Page, cards: CardId[]): Promise<void> {
  for (const id of cards) {
    await page.locator(`.card[data-card-id="${id}"]`).click();
  }
  const claim = page.getByTestId('claim');
  await expect(claim).toBeEnabled();
  await claim.click();
}

/** This player's own score, read from the score strip. */
export async function myScore(page: Page): Promise<number> {
  const text = await page.locator('.scoreChip--me .scoreChip__score').innerText();
  return Number(text.trim());
}

/** Score of a named player, read from the score strip. */
export async function scoreOf(page: Page, name: string): Promise<number> {
  const text = await page
    .locator(`.scoreChip[data-player-name="${name}"] .scoreChip__score`)
    .innerText();
  return Number(text.trim());
}

/** Assert the page never scrolls sideways — a hard requirement on phones. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });
  // Allow one pixel for sub-pixel rounding on fractional device ratios.
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** True once this player is looking at the results screen. */
async function isFinished(page: Page): Promise<boolean> {
  return page
    .getByTestId('results-headline')
    .isVisible()
    .catch(() => false);
}

/**
 * Wait until this player is free to act.
 *
 * "No SET on board" is disabled for exactly one reason — this player's own
 * cooldown after a wrong call — so it doubles as the "am I cooling down?" signal.
 */
async function waitOutCooldown(page: Page): Promise<void> {
  await expect(page.getByTestId('no-set')).toBeEnabled({ timeout: 15_000 });
}

/**
 * Unpick anything still selected.
 *
 * A claim that did not go through leaves three cards picked, and picking three
 * more on top of them is refused — so a loop that does not clear up after itself
 * spends the rest of the game re-claiming the same stale triple.
 */
async function clearSelection(page: Page): Promise<void> {
  for (const card of await page.locator('.card--selected').all()) {
    await card.click({ timeout: 5_000 }).catch(() => undefined);
  }
  await expect(page.locator('.card--selected')).toHaveCount(0, { timeout: 5_000 });
}

/**
 * Play a whole game out by having players alternately claim any available set,
 * or call "no SET" when the board has none. Returns when the game finishes.
 */
export async function playToCompletion(players: PlayerSession[]): Promise<void> {
  // A full game is at most 27 claims plus a handful of "no SET" calls; the budget
  // is deliberately loose, because a lost race costs an action without progress.
  for (let action = 0; action < 150; action++) {
    const actor = players[action % players.length]!;
    if (await isFinished(actor.page)) return;
    await waitOutCooldown(actor.page);
    await clearSelection(actor.page);

    const board = await boardCardIds(actor.page);
    if (board.length === 0) return;
    const found = findFirstSet(board);
    if (!found) {
      const noSet = actor.page.getByTestId('no-set');
      if (await noSet.isEnabled()) await noSet.click();
      await actor.page.waitForTimeout(250);
      continue;
    }

    for (const id of found) {
      await actor.page.locator(`.card[data-card-id="${id}"]`).click({ timeout: 5_000 });
    }
    const claim = actor.page.getByTestId('claim');
    if (!(await claim.isEnabled())) continue;
    await claim.click();
    // Wait for the authoritative board to move on. It may not: another player can
    // take the same set first, in which case the next pass simply tries again.
    await actor.page
      .waitForFunction(
        (ids: number[]) =>
          !ids.every((id) =>
            document.querySelector(`.card[data-card-id="${id}"]:not(.card--exit)`),
          ),
        [...found],
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    if (await isFinished(actor.page)) return;
  }
  throw new Error('game did not finish in a reasonable number of actions');
}
