/**
 * The spoiler gate, for pictures.
 *
 * On games like Blue Prince the picture *is* the answer — a scan of an in-game
 * document — so it must not be on screen until the hint it belongs to has been
 * revealed by a tap. Structurally that comes from `HintsView` rendering
 * `hint.images` inside the revealed `<li>`, which is one careless refactor away
 * from being hoisted out of it, and nothing else would notice.
 *
 * Run against the local Compose stack, with at least one game wiki allowlisted:
 *   docker compose -f docker-compose.local.yml up -d
 *   npm run test:e2e --workspace web
 *
 * Skipped when no wiki is allowlisted — that is an operator's choice, not a
 * failure.
 */

import { expect, test, type Page } from '@playwright/test';

interface Target {
  id: string;
  label: string;
  /** Index of the hint the picture hangs off. */
  at: number;
  hints: number;
}

/** Download a wiki game and find a hint that ended up with a stored picture. */
async function downloadAndLocate(page: Page, host: string): Promise<Target | null> {
  const id = await page.evaluate(async (wiki: string) => {
    const mod = await import('/src/storage/download.ts');
    const { stored } = await mod.downloadEntry({
      sourceKind: wiki.endsWith('.wiki.gg') ? 'wikigg' : 'fandom',
      ref: wiki,
      host: wiki,
      title: '',
      normalizedTitle: '',
    } as never);
    return stored.id;
  }, host);

  return page.evaluate(async (documentId: string) => {
    const db = await import('/src/storage/db.ts');
    const ast = await import('/src/parser/ast.ts');
    const doc = await db.getDocument(documentId);
    if (!doc) return null;
    let fallback: Target | null = null;
    for (const node of ast.walk(doc.document.root)) {
      if (node.type !== 'hints' || !node.id) continue;
      const at = node.hints.findIndex((hint) => hint.images?.some((image) => image.blobKey));
      if (at < 0) continue;
      const found = { id: node.id, label: node.label, at, hints: node.hints.length };
      // Prefer a picture that is *not* on the first hint: that proves it stays
      // hidden while an earlier hint of the same question is already showing.
      if (at >= 1) return found;
      fallback ??= found;
    }
    return fallback;
  }, id);
}

/**
 * Open a question by name, the way a person would.
 *
 * Reloaded first, and not merely re-navigated: the library list is built when
 * that screen mounts, and the download above happened afterwards. Tapping the
 * Library tab while already on it would leave the stale, empty list on screen
 * and wait forever for a row that is never going to appear.
 */
async function openQuestion(page: Page, label: string): Promise<void> {
  await page.goto('/');
  // The library row, not the nav: both are links, and the nav comes first. The
  // app uses a hash router, so the href is `#/read/…` and not `/read/…`.
  await page.locator('a[href*="#/read/"]').first().click();
  await page.waitForSelector('.reader');
  await page.getByRole('button', { name: 'Find in this document' }).click();
  await page.getByRole('searchbox').fill(label);
  await page.locator('.find-results .row-main').first().click();
  await page.waitForSelector('.hints');
}

test('a wiki picture stays hidden until its own hint is revealed', async ({ page, context }) => {
  // A wiki game is sixty pages and then a few hundred pictures, fetched two at
  // a time out of politeness. Blue Prince measured 105 seconds; the suite's
  // three-minute default is not enough on its own.
  test.setTimeout(900_000);
  await page.goto('/');
  const wikis = await page.evaluate(async () => {
    const response = await fetch('/api/wiki/allow');
    return ((await response.json()) as { wikis: { host: string }[] }).wikis;
  });
  test.skip(wikis.length === 0, 'no game wiki is allowlisted in this deployment');

  const target = await downloadAndLocate(page, wikis[0]!.host);
  test.skip(target === null, `no picture was stored from ${wikis[0]!.host}`);

  await openQuestion(page, target!.label);
  const pictures = page.locator('.hint-image img');

  // Nothing revealed yet.
  await expect(pictures).toHaveCount(0);

  for (let i = 0; i < target!.at; i++) {
    await page.getByRole('button', { name: /Show the (first|next) hint/ }).click();
    // Still nothing: an earlier hint of the same question is showing, and the
    // picture belongs to a later one.
    await expect(pictures).toHaveCount(0);
  }

  await page.getByRole('button', { name: /Show the (first|next) hint/ }).click();
  await expect(pictures.first()).toBeVisible();

  // Offline, the stored copy still renders and the full-size button says why it
  // cannot be used — rather than failing at the moment a hint is wanted.
  const before = await pictures.count();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await expect(pictures).toHaveCount(before);
  const fullSize = page.locator('.hint-image button', { hasText: /full size|Fetch it/ }).last();
  await expect(fullSize).toBeDisabled();
  await expect(fullSize).toHaveAttribute('title', /Needs a connection/);
});
