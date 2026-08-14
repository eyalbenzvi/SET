/**
 * Language, text direction, and the invite flow.
 *
 * Also home to the regression test for the input bug that made the name field
 * eject the player after every letter — typed here character by character,
 * because `fill()` sets a value in one operation and cannot reproduce it.
 */

import { expect, test } from '@playwright/test';
import { closePlayers, createRoom, joinByLink, newPlayer, startGame } from './helpers.js';

test.describe('Hebrew by default', () => {
  test('loads in Hebrew, right to left, with no English left on screen', async ({
    browser,
  }, testInfo) => {
    // No locale pinned: this is what a first-time visitor gets.
    const maya = await newPlayer(browser, 'מיה', null);
    await maya.page.goto('./');

    const html = maya.page.locator('html');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveAttribute('lang', 'he');

    await expect(maya.page.getByTestId('create-game')).toHaveText('משחק חדש');
    await expect(maya.page.getByTestId('join-game')).toHaveText('הצטרפות למשחק');
    await expect(maya.page.getByTestId('how-to-play')).toHaveText('איך משחקים');
    await expect(maya.page.locator('.hero__explain')).toContainText('שלושה קלפים');

    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-he-home.png` });
    await closePlayers(maya);
  });

  test('the rules sheet answers the turn, refill and deck questions in Hebrew', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'מיה', null);
    await maya.page.goto('./');
    await maya.page.getByTestId('how-to-play').click();

    const dialog = maya.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The four things players actually asked about.
    await expect(dialog).toContainText('אין תורות');
    await expect(dialog).toContainText('מתמלא');
    await expect(dialog).toContainText('קופה');
    await expect(dialog).toContainText('81');
    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-he-rules.png` });
    await closePlayers(maya);
  });

  test('the game board is Hebrew and the card labels agree grammatically', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'מיה', null);
    const david = await newPlayer(browser, 'דוד', null);
    const code = await createRoom(maya);
    await joinByLink(david, code);
    await startGame(maya, david);

    await expect(maya.page.getByTestId('claim')).toContainText('מצאתי SET');
    await expect(maya.page.getByTestId('no-set')).toContainText('אין SET על השולחן');
    await expect(maya.page.getByTestId('feed')).toContainText('מתחילים');

    // A three-symbol card must read "3 <plural shape> <plural colour> <plural fill>".
    const labels = await maya.page
      .locator('.card[data-count="three"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
    for (const label of labels) {
      expect(label).toMatch(
        /^3 (סגלגלים|מעוינים|גליים) (אדומים|ירוקים|סגולים) (ריקים|מפוספסים|מלאים)$/,
      );
    }

    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-he-game.png` });
    await closePlayers(maya, david);
  });

  test('the language switch flips to English and back, and is remembered', async ({ browser }) => {
    const maya = await newPlayer(browser, 'מיה', null);
    await maya.page.goto('./');
    await expect(maya.page.getByTestId('create-game')).toHaveText('משחק חדש');

    await maya.page.getByTestId('lang-en').click();
    await expect(maya.page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(maya.page.getByTestId('create-game')).toHaveText('Create game');

    // Survives a reload.
    await maya.page.reload();
    await expect(maya.page.getByTestId('create-game')).toHaveText('Create game');

    await maya.page.getByTestId('lang-he').click();
    await expect(maya.page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(maya.page.getByTestId('create-game')).toHaveText('משחק חדש');
    await closePlayers(maya);
  });
});

test.describe('typing into the name and code fields', () => {
  test('a name can be typed one letter at a time without losing focus', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await maya.page.getByTestId('create-game').click();

    const name = maya.page.locator('#player-name');
    await name.click();
    // Character by character, the way a person types. `fill()` would set the
    // whole value in one operation and would not have caught the original bug.
    await name.pressSequentially('Maya Cohen', { delay: 30 });

    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Maya Cohen');
    // The caret is still at the end, so the next letter lands where expected.
    expect(await name.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(10);

    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.getByTestId('room-code')).toBeVisible();
    await expect(maya.page.getByTestId('player-list')).toContainText('Maya Cohen');
    await closePlayers(maya);
  });

  test('a Hebrew name can be typed one letter at a time', async ({ browser }) => {
    const maya = await newPlayer(browser, 'מיה', null);
    await maya.page.goto('./');
    await maya.page.getByTestId('create-game').click();

    const name = maya.page.locator('#player-name');
    await name.click();
    await name.pressSequentially('מיה כהן', { delay: 30 });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('מיה כהן');

    await maya.page.getByTestId('submit-name').click();
    await expect(maya.page.getByTestId('player-list')).toContainText('מיה כהן');
    await closePlayers(maya);
  });

  test('the room code can be typed one letter at a time and is upper-cased in place', async ({
    browser,
  }) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.page.goto('./');
    await maya.page.getByTestId('join-game').click();

    const code = maya.page.locator('#room-code');
    await code.click();
    await code.pressSequentially('abc234', { delay: 30 });
    await expect(code).toBeFocused();
    await expect(code).toHaveValue('ABC234');
    expect(await code.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(6);

    // And the name field after it, still in the same visit.
    const name = maya.page.locator('#player-name');
    await name.click();
    await name.pressSequentially('Maya', { delay: 30 });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Maya');
    await closePlayers(maya);
  });
});

test.describe('invite flow', () => {
  test('offers the code, a QR of the link, and copy buttons that confirm', async ({
    browser,
  }, testInfo) => {
    const maya = await newPlayer(browser, 'Maya');
    // Clipboard writes need permission *and* a focused document in Chromium;
    // without `bringToFront` the write rejects and the button never confirms.
    await maya.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const code = await createRoom(maya);
    await maya.page.bringToFront();

    // A QR of the invite link, drawn in-page with no network request.
    const qr = maya.page.locator('.qr');
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('aria-label', new RegExp(code));
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThan(80);

    // Copy code confirms on the button, then reverts.
    const copyCode = maya.page.getByTestId('copy-code');
    await copyCode.click();
    await expect(copyCode).toContainText('Copied');
    expect(await maya.page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(copyCode).toContainText('Copy code', { timeout: 5_000 });

    // Copy link puts the full join URL on the clipboard.
    await maya.page.getByTestId('copy-link').click();
    const copied = await maya.page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`#room=${code}`);
    expect(copied).toContain('/set/');

    // The long URL is available but folded away.
    const disclosure = maya.page.locator('.disclosure');
    await expect(disclosure).toBeVisible();
    await expect(maya.page.locator('.invite__url')).toHaveText(copied);

    await maya.page.screenshot({ path: `screenshots/${testInfo.project.name}-invite.png` });
    await closePlayers(maya);
  });

  test('a scanned invite link actually opens the right room', async ({ browser }) => {
    const maya = await newPlayer(browser, 'Maya');
    await maya.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const code = await createRoom(maya);
    await maya.page.bringToFront();
    await maya.page.getByTestId('copy-link').click();
    const url = await maya.page.evaluate(() => navigator.clipboard.readText());

    // Follow it exactly as a phone would after scanning the QR.
    const david = await newPlayer(browser, 'David');
    await david.page.goto(url);
    await expect(david.page.locator('#room-code')).toHaveValue(code);
    await david.page.locator('#player-name').fill('David');
    await david.page.getByTestId('submit-name').click();
    await expect(david.page.getByTestId('room-code')).toHaveText(code);
    await expect(maya.page.getByTestId('player-list')).toContainText('David');

    await closePlayers(maya, david);
  });
});
