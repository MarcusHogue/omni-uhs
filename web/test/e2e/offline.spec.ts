/**
 * The headline requirement (spec §12).
 *
 * Download two games over the network, go offline, reload as a cold launch,
 * then navigate and reveal hints in both — with zero network requests and zero
 * console errors.
 *
 * Run against the local Compose stack:
 *   docker compose -f docker-compose.local.yml up -d
 *   npm run test:e2e --workspace web
 */

import { expect, test, type Page } from '@playwright/test';

const TITLES = ['Adventure 660', 'Zork I'];

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null,
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Walk down the subject tree, always taking the first child, until a question
 * with an unrevealed hint is reached.
 */
async function drillToFirstQuestion(page: Page): Promise<void> {
  for (let depth = 0; depth < 8; depth++) {
    const reveal = page.getByRole('button', { name: /Show the first hint/ });
    if (await reveal.isVisible().catch(() => false)) return;

    // Take a question if this level has one, otherwise descend into the first
    // subject. Text and image nodes are dead ends for this walk.
    const question = page.locator('.row[data-type="hints"] .row-main').first();
    if (await question.isVisible().catch(() => false)) {
      await question.click();
      continue;
    }
    const subject = page.locator('.row[data-type="subject"] .row-main').first();
    await expect(subject).toBeVisible();
    await subject.click();
  }
  throw new Error('no question found within 8 levels');
}

async function downloadFirstResult(page: Page, query: string): Promise<string> {
  await page.getByRole('navigation').getByRole('link', { name: 'Search' }).click();
  const box = page.getByLabel('Search for a game');
  await box.fill(query);

  // The first group whose entry can actually be downloaded (IFDB is metadata
  // only, so its button is disabled).
  const button = page
    .getByRole('button', { name: /^Download$/ })
    .first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();

  // A successful download navigates into the reader.
  await expect(page).toHaveURL(/#\/read\//, { timeout: 120_000 });
  const title = await page.locator('.crumbs strong').first().innerText();
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
  return title;
}

test('downloads two games, then reads both with the network off', async ({
  page,
  context,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // --- online: install and download ---------------------------------------
  await page.goto('/');
  await waitForServiceWorker(page);

  for (const query of ['adventure 660', 'zork i']) {
    await downloadFirstResult(page, query);
  }

  const library = page.locator('.row-title');
  await expect(library).toHaveCount(2, { timeout: 10_000 });
  for (const title of TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByText('Available offline').first()).toBeVisible();

  // --- offline: cold launch ------------------------------------------------
  const requestsWhileOffline: string[] = [];
  page.on('request', (request) => requestsWhileOffline.push(request.url()));

  await context.setOffline(true);
  // A full reload with no network is the "force-quit and relaunch" case.
  await page.reload({ waitUntil: 'load' });

  // The header pill, not the per-title "Available offline" badges.
  await expect(page.locator('.app-header .pill-offline')).toHaveText('Offline');
  await expect(page.locator('.row-title')).toHaveCount(2);

  // --- offline: read both --------------------------------------------------
  for (let i = 0; i < 2; i++) {
    await page.locator('.row-main').nth(i).click();
    await expect(page).toHaveURL(/#\/read\//);

    await drillToFirstQuestion(page);
    const reveal = page.getByRole('button', { name: /Show the first hint/ });
    await expect(reveal).toBeVisible();

    // Nothing is revealed until it is asked for.
    await expect(page.locator('.hint')).toHaveCount(0);
    await reveal.click();
    await expect(page.locator('.hint')).toHaveCount(1);

    const next = page.getByRole('button', { name: /Show the next hint/ });
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await expect(page.locator('.hint')).toHaveCount(2);
    }

    await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
  }

  // Zero network: every request while offline must have been served by the
  // service worker or not made at all.
  const networkAttempts = requestsWhileOffline.filter((url) => url.includes('/api/'));
  expect(networkAttempts).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('reveal state survives a reload', async ({ page }) => {
  await page.goto('/');
  await waitForServiceWorker(page);
  await downloadFirstResult(page, 'adventure 660');

  await page.locator('.row-main').first().click();
  await drillToFirstQuestion(page);
  await page.getByRole('button', { name: /Show the first hint/ }).click();
  await expect(page.locator('.hint')).toHaveCount(1);

  const url = page.url();
  await page.reload();
  await page.goto(url);
  await expect(page.locator('.hint')).toHaveCount(1);
});

test('in-document search never matches hint bodies', async ({ page }) => {
  await page.goto('/');
  await waitForServiceWorker(page);
  await downloadFirstResult(page, 'adventure 660');
  await page.locator('.row-main').first().click();

  // A phrase that only ever appears inside an unrevealed hint body must not
  // produce a match, and must not appear anywhere in the DOM.
  const find = page.getByLabel('Find in this document');
  await find.fill('lamp');
  await expect(page.getByText(/matches? in section and question titles/)).toBeVisible();

  const matches = page.locator('.find-results .row');
  const count = await matches.count();
  for (let i = 0; i < count; i++) {
    // Every match must be a label, i.e. it is visible as a row title.
    await expect(matches.nth(i).locator('.row-title')).toBeVisible();
  }
  await expect(page.locator('.hint')).toHaveCount(0);
});
