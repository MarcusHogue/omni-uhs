/**
 * The spoiler gate, for pictures.
 *
 * On games like Blue Prince the picture *is* the answer — a scan of an in-game
 * document — so it must not be on screen until the hint it belongs to has been
 * revealed by a tap. Structurally that comes from `HintsView` rendering
 * `hint.images` inside the revealed `<li>`, which is one careless refactor away
 * from being hoisted out of it, and nothing else would notice: the stored AST is
 * identical either way.
 *
 * Run against the local Compose stack, with at least one game wiki allowlisted:
 *   docker compose -f docker-compose.local.yml up -d
 *   npm run test:e2e --workspace web
 *
 * Skipped when no wiki is browsable, or when the one downloaded had no pictures
 * worth storing — both are deployment facts, not failures.
 *
 * Nothing here imports from `src/`. The app under test is a *built* bundle, so
 * `import('/src/…')` would only resolve under `vite dev`; the document is read
 * back through plain `indexedDB` instead, and the download is driven by tapping
 * the same buttons a person would.
 */

import { expect, test, type Page } from '@playwright/test';

/** Just enough of the stored AST to find a picture. Deliberately structural. */
interface HintLike {
  images?: { blobKey?: string }[];
}
interface NodeLike {
  type: string;
  id?: string;
  label: string;
  children?: NodeLike[];
  hints?: HintLike[];
}
interface StoredLike {
  document?: { root?: NodeLike };
}

interface Target {
  /** The question's label, to find it by. */
  label: string;
  /** Index of the hint the picture hangs off. */
  at: number;
}

/** A wiki game, downloaded by tapping Browse → platform → Download. */
async function downloadAWikiGame(page: Page): Promise<boolean> {
  await page.goto('/#/browse');
  const platform = page.locator('a[href*="#/browse/fandom"], a[href*="#/browse/wikigg"]').first();
  if (!(await platform.isVisible().catch(() => false))) return false;
  await platform.click();

  const download = page.getByRole('button', { name: /^(Download|Re-download)$/ }).first();
  if (!(await download.isVisible({ timeout: 30_000 }).catch(() => false))) return false;
  await download.click();

  // Sixty pages and then a few hundred pictures, two at a time out of
  // politeness. Arriving in the reader is how the download reports success.
  await expect(page.locator('.reader')).toBeVisible({ timeout: 600_000 });
  return true;
}

/**
 * Find a question whose picture hangs off a hint, read straight out of storage.
 *
 * Prefers one where the picture is *not* on the first hint: that proves it stays
 * hidden while an earlier hint of the same question is already on screen.
 */
async function locatePicture(page: Page): Promise<Target | null> {
  return page.evaluate(async () => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('omni-uhs');
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void => reject(request.error);
      });
    const db = await open();
    const documents = await new Promise<StoredLike[]>((resolve, reject) => {
      const request = db.transaction('documents').objectStore('documents').getAll();
      request.onsuccess = (): void => resolve(request.result as StoredLike[]);
      request.onerror = (): void => reject(request.error);
    });

    let fallback: Target | null = null;
    for (const stored of documents) {
      const stack: NodeLike[] = stored.document?.root ? [stored.document.root] : [];
      while (stack.length > 0) {
        const node = stack.pop()!;
        for (const child of node.children ?? []) stack.push(child);
        if (node.type !== 'hints' || !node.hints) continue;
        const at = node.hints.findIndex((hint) =>
          (hint.images ?? []).some((image) => Boolean(image.blobKey)),
        );
        if (at < 0) continue;
        if (at >= 1) return { label: node.label, at };
        fallback ??= { label: node.label, at };
      }
    }
    return fallback;
  });
}

/** Open a question by name, the way a person would. */
async function openQuestion(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Find in this document' }).click();
  await page.getByRole('searchbox', { name: 'Find in this document' }).fill(label);
  await page.locator('.find-results .row-main').first().click();
  await page.waitForSelector('.hints');
}

test('a wiki picture stays hidden until its own hint is revealed', async ({ page, context }) => {
  // The download dominates: a cold one is minutes, a warm cache is seconds.
  test.setTimeout(900_000);

  const downloaded = await downloadAWikiGame(page);
  test.skip(!downloaded, 'no game wiki is browsable in this deployment');

  const target = await locatePicture(page);
  test.skip(target === null, 'the wiki that was downloaded stored no pictures');

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
