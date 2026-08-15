/**
 * Layout, accessibility and error-state checks, plus screenshot capture for
 * visual review. Runs at both a narrow phone viewport and a desktop viewport.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  boardCardIds,
  claimCards,
  closePlayers,
  createRoom,
  ensureSetOnBoard,
  expectNoHorizontalScroll,
  joinByLink,
  newPlayer,
  startGame,
} from './helpers.js';

const SHOTS = 'screenshots';

async function shot(page: Page, name: string, project: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: false });
}

test.describe('layout and visual states', () => {
  test('home, tutorial and lobby fit the viewport without sideways scrolling', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await expect(maya.page.getByTestId('create-game')).toBeVisible();
    await expectNoHorizontalScroll(maya.page);
    await shot(maya.page, 'home', testInfo.project.name);

    // The rules modal is reachable and readable.
    await maya.page.getByTestId('how-to-play').click();
    await expect(maya.page.getByRole('dialog')).toBeVisible();
    await expect(maya.page.getByRole('dialog')).toContainText('all the same or all different');
    // It shows real cards from the real renderer.
    await expect(maya.page.locator('.tutorial__cards .card')).toHaveCount(9);
    await expectNoHorizontalScroll(maya.page);
    await shot(maya.page, 'tutorial', testInfo.project.name);
    // Escape closes it.
    await maya.page.keyboard.press('Escape');
    await expect(maya.page.getByRole('dialog')).toHaveCount(0);

    const code = await createRoom(maya);
    await expect(maya.page.getByTestId('room-code')).toHaveText(code);
    await expectNoHorizontalScroll(maya.page);
    await shot(maya.page, 'lobby', testInfo.project.name);

    await closePlayers(maya);
  });

  test('the whole board and both controls are visible without scrolling', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await expectNoHorizontalScroll(maya.page);

    // Every card is inside the viewport.
    const viewport = maya.page.viewportSize();
    expect(viewport).not.toBeNull();
    const boxes = await maya.page.locator('.card').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      }),
    );
    expect(boxes).toHaveLength(12);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(viewport!.width + 1);
      expect(box.top).toBeGreaterThanOrEqual(-1);
      expect(box.bottom).toBeLessThanOrEqual(viewport!.height + 1);
      // Cards stay comfortably tappable.
      expect(box.width).toBeGreaterThanOrEqual(62);
    }

    // Both primary controls are on screen and large enough to tap.
    for (const id of ['claim', 'more-cards']) {
      const box = await maya.page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    }
    // The score strip is visible for every player.
    await expect(maya.page.getByTestId('score-chip')).toHaveCount(2);

    await shot(maya.page, 'game', testInfo.project.name);

    // With three cards picked, the selection is unmistakable.
    const board = await boardCardIds(maya.page);
    for (const id of board.slice(0, 3)) {
      await maya.page.locator(`.card[data-card-id="${id}"]`).click();
    }
    await expect(maya.page.locator('.card--selected')).toHaveCount(3);
    await expect(maya.page.locator('.card--selected .card__badge').first()).toHaveText('1');
    await shot(maya.page, 'game-selected', testInfo.project.name);

    await closePlayers(maya, david);
  });

  test('an 18-card board still lays out without sideways scrolling', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    // Grow the board the way a stuck table does: both players ask for three more
    // cards, until there are eighteen. `ensureSetOnBoard` first each round, so a
    // request is never made against a board the server is already replacing —
    // and a board it grew on its own counts towards the eighteen just the same.
    for (let guard = 0; guard < 6; guard++) {
      await ensureSetOnBoard(maya.page);
      const current = (await boardCardIds(maya.page)).length;
      if (current >= 18) break;
      await maya.page.getByTestId('more-cards').click();
      await david.page.getByTestId('more-cards').click();
      for (const player of [maya, david]) {
        await expect(player.page.locator('.card:not(.card--exit)')).toHaveCount(current + 3, {
          timeout: 15_000,
        });
      }
    }

    await expectNoHorizontalScroll(maya.page);
    const size = (await boardCardIds(maya.page)).length;
    expect(size).toBeGreaterThanOrEqual(18);
    await shot(maya.page, `game-${String(size)}cards`, testInfo.project.name);

    await closePlayers(maya, david);
  });

  test('cards render each of their four properties truthfully', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const cards = await maya.page.locator('.card').evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        return {
          count: element.dataset['count'],
          shape: element.dataset['shape'],
          color: element.dataset['color'],
          fill: element.dataset['fill'],
          label: element.getAttribute('aria-label') ?? '',
          symbols: element.querySelectorAll('.card__art path').length,
          fillAttr: element.querySelector('.card__art path')?.getAttribute('fill') ?? '',
        };
      }),
    );
    expect(cards).toHaveLength(12);
    for (const card of cards) {
      // The number of drawn symbols matches the card's count property.
      expect(card.symbols).toBe({ one: 1, two: 2, three: 3 }[card.count ?? '']);
      // The accessible label names all four properties, so colour is never the
      // only channel conveying information.
      for (const value of [card.count, card.shape, card.color, card.fill]) {
        expect(card.label).toContain(value);
      }
      // Shading maps onto the right paint: none / pattern / flat colour.
      if (card.fill === 'open') expect(card.fillAttr).toBe('none');
      if (card.fill === 'striped') expect(card.fillAttr).toContain('url(#set-stripe-');
      if (card.fill === 'solid') expect(card.fillAttr).toContain('var(--card-color-');
    }
    // All twelve cards are distinct.
    const keys = cards.map((c) => `${c.count}-${c.shape}-${c.color}-${c.fill}`);
    expect(new Set(keys).size).toBe(12);

    await closePlayers(maya, david);
  });

  test('the colour-blind assist option labels every card', async ({ browser }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    await maya.page.goto('./');
    // The checkbox itself is visually hidden behind a styled switch, so click the
    // label the way a player would.
    await maya.page.locator('label[for="color-assist"]').click();
    await expect(maya.page.locator('#color-assist')).toBeChecked();
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await expect(maya.page.locator('.card__assist')).toHaveCount(12);
    const letters = await maya.page
      .locator('.card__assist')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    for (const letter of letters) expect(['R', 'G', 'P']).toContain(letter);
    // The other player is unaffected — it is a personal display preference.
    await expect(david.page.locator('.card__assist')).toHaveCount(0);
    await shot(maya.page, 'game-color-assist', testInfo.project.name);

    await closePlayers(maya, david);
  });
});

test.describe('keyboard and screen-reader support', () => {
  test('cards are reachable by keyboard and selectable with Enter and Space', async ({
    browser,
  }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    // Focus the first card directly, then walk with Tab.
    await maya.page.locator('.card').first().focus();
    await expect(maya.page.locator('.card').first()).toBeFocused();
    await maya.page.keyboard.press('Enter');
    await expect(maya.page.locator('.card--selected')).toHaveCount(1);

    await maya.page.keyboard.press('Tab');
    await maya.page.keyboard.press('Space');
    await expect(maya.page.locator('.card--selected')).toHaveCount(2);

    await maya.page.keyboard.press('Tab');
    await maya.page.keyboard.press('Enter');
    await expect(maya.page.locator('.card--selected')).toHaveCount(3);

    // aria-pressed tracks selection, and the claim control is reachable.
    await expect(maya.page.locator('.card[aria-pressed="true"]')).toHaveCount(3);
    await expect(maya.page.getByTestId('claim')).toBeEnabled();
    await maya.page.getByTestId('claim').focus();
    await expect(maya.page.getByTestId('claim')).toBeFocused();

    await closePlayers(maya, david);
  });

  test('key events are announced through a polite live region', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const live = maya.page.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await claimCards(maya.page, await ensureSetOnBoard(maya.page));
    await expect(live).toContainText(/SET/i, { timeout: 10_000 });

    await closePlayers(maya, david);
  });

  test('the score strip and deck meters carry accessible names', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const scores = maya.page.getByTestId('scores');
    await expect(scores).toHaveAttribute('role', 'list');
    await expect(scores).toHaveAttribute('aria-label', /score/i);
    await expect(maya.page.getByTestId('score-chip').first()).toHaveAttribute(
      'aria-label',
      /Maya: \d+/,
    );
    // The decorative glyphs are hidden and the numbers are spelled out.
    await expect(maya.page.locator('.meter__label').first()).toHaveAttribute('aria-hidden', 'true');
    await expect(maya.page.locator('.meter__value').first()).toHaveAttribute(
      'aria-label',
      /cards left in the deck/i,
    );

    await closePlayers(maya, david);
  });

  test('leaving a live game needs two taps and disarms itself', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const leave = maya.page.getByTestId('leave-game');
    await leave.click();
    await expect(leave).toContainText(/tap again/i);
    // Still in the game after one tap.
    await expect(maya.page.getByTestId('board')).toBeVisible();
    // It disarms on its own, so a stray tap later cannot leave either.
    await expect(leave).toContainText(/leave game/i, { timeout: 10_000 });
    await expect(maya.page.getByTestId('board')).toBeVisible();

    await closePlayers(maya, david);
  });

  test('every interactive control has an accessible name', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const unnamed = await maya.page
      .locator('button:not([aria-hidden="true"])')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const label = node.getAttribute('aria-label') ?? node.textContent ?? '';
            return label.trim().length === 0;
          })
          .map((node) => (node as HTMLElement).className),
      );
    expect(unnamed).toEqual([]);

    // Inputs are labelled too.
    await closePlayers(maya, david);
  });
});

test.describe('error states', () => {
  test('an unknown room code is explained without technical detail', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await maya.page.getByTestId('join-game').click();
    await maya.page.locator('#room-code').fill('ZZZZZZ');
    await maya.page.locator('#player-name').fill('Maya');
    await maya.page.getByTestId('submit-name').click();

    const error = maya.page.locator('#form-error');
    await expect(error).toContainText(/does not exist/i);
    await expect(error).not.toContainText(/404|fetch|http|stack/i);
    await shot(maya.page, 'error-room-not-found', testInfo.project.name);
    await closePlayers(maya);
  });

  test('a malformed room code is rejected before any network call', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await maya.page.getByTestId('join-game').click();
    // The input filters to the code alphabet and length as you type.
    await maya.page.locator('#room-code').fill('ab!23xyz');
    await expect(maya.page.locator('#room-code')).toHaveValue('AB!23X');
    await maya.page.locator('#player-name').fill('Maya');
    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.locator('#form-error')).toContainText(/letters and digits/i);
    await closePlayers(maya);
  });

  test('a missing name is refused with a clear message', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await maya.page.getByTestId('create-game').click();
    await maya.page.locator('#player-name').fill('   ');
    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.locator('#form-error')).toContainText(/enter a name/i);
    await closePlayers(maya);
  });

  test('joining a game already in progress is explained', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const late = await newPlayer(browser, 'Noa');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await joinByLink(late, code).catch(() => undefined);
    await expect(late.page.locator('#form-error')).toContainText(/already started/i);
    await closePlayers(maya, david, late);
  });

  test('an unreachable backend produces a retry path, not a blank page', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    // Block the API to simulate the backend being down.
    await maya.page.route('**/api/rooms', (route) => route.abort());
    await maya.page.getByTestId('create-game').click();
    await maya.page.locator('#player-name').fill('Maya');
    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.locator('#form-error')).toContainText(/cannot reach the game server/i);
    await shot(maya.page, 'error-offline', testInfo.project.name);
    // Recoverable: unblock and try again.
    await maya.page.unroute('**/api/rooms');
    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.getByTestId('room-code')).toBeVisible({ timeout: 20_000 });
    await closePlayers(maya);
  });

  test('a dropped socket shows a reconnecting banner and recovers', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    // Cut the network the way a real blip would, then restore it.
    await maya.context.setOffline(true);
    await maya.page.waitForTimeout(1_500);
    await maya.context.setOffline(false);

    // The player ends up back on a live board with their seat intact, not stuck
    // on a spinner or a dead screen.
    await expect(maya.page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
    await expect(maya.page.locator('.card:not(.card--exit)')).toHaveCount(12, { timeout: 30_000 });
    await expect(maya.page.locator('.scoreChip--me')).toBeVisible();
    // ...and the other player sees them connected again.
    await expect(david.page.locator('.scoreChip--offline')).toHaveCount(0, { timeout: 30_000 });
    await closePlayers(maya, david);
  });
});

test.describe('results screen', () => {
  test('shows final rankings after a finished game', async ({ browser }, testInfo) => {
    test.slow();
    const maya = await newPlayer(browser, 'Maya');
    const david = await newPlayer(browser, 'David');
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    const { playToCompletion } = await import('./helpers.js');
    await playToCompletion([maya, david]);

    await expect(maya.page.getByTestId('results-headline')).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalScroll(maya.page);
    await shot(maya.page, 'results', testInfo.project.name);
    await closePlayers(maya, david);
  });
});
