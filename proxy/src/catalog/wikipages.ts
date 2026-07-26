/**
 * Which pages of a game wiki are worth reading.
 *
 * A wiki *is* a game, so downloading one should hand you the game, not a list
 * of pages to collect by hand. That turns a search result into a single title
 * and moves the question here: out of the thousands of pages on a game wiki,
 * which ones carry guidance?
 *
 * Two passes, in order of precision:
 *
 * 1. **Categories.** Game wikis file their guidance under a small set of names
 *    that recur across both platforms — Puzzles, Secrets, Endings, Bosses. When
 *    a wiki uses them, they are the best signal available, and asking costs one
 *    request each.
 * 2. **Search**, when the categories come up short. A wiki that files nothing
 *    still has pages about its own game, so the game's name is the query.
 *
 * Precision is not the point of either. Anything that slips through is caught
 * at parse time by the prose-density classifier, which drops the stat tables;
 * the job here is a superset small enough to fetch politely.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { log } from '../log.js';
import { apiUrl, type WikiTarget } from './mediawiki.js';

/**
 * Categories that hold guidance rather than reference data.
 *
 * Singular and plural both, because wikis are inconsistent and a miss costs a
 * 200 with an empty list rather than an error.
 */
const GUIDANCE_CATEGORIES = [
  'Walkthrough',
  'Walkthroughs',
  'Puzzles',
  'Puzzle',
  'Secrets',
  'Endings',
  'Bosses',
  'Quests',
  'Guides',
  'Collectibles',
];

/** Below this, the categories have not told us enough and search is worth it. */
const SPARSE = 8;

/** Never fetch more than this from one wiki, however much it offers. */
const MAX_PAGES = 60;

interface ListPayload {
  query?: {
    categorymembers?: { title?: string; ns?: number }[];
    search?: { title?: string }[];
  };
}

const titlesFrom = (payload: ListPayload): string[] =>
  [...(payload.query?.categorymembers ?? []), ...(payload.query?.search ?? [])]
    .filter((row) => (row as { ns?: number }).ns === undefined || (row as { ns?: number }).ns === 0)
    .map((row) => row.title)
    .filter((title): title is string => Boolean(title));

async function list(cache: Cache, target: WikiTarget, params: Record<string, string>) {
  const url = apiUrl(target.api, params);
  const entry = await cache.fetch({
    url,
    ttl: config.ttl.index,
    accept: 'application/json',
    ...(target.allowlist ? { allowlist: target.allowlist } : {}),
  });
  return titlesFrom(JSON.parse(await cache.readText(entry)) as ListPayload);
}

export interface PageCandidates {
  titles: string[];
  /** Where each pass got to, so a thin result can be explained rather than guessed at. */
  fromCategories: number;
  fromSearch: number;
}

export async function gatherPages(
  cache: Cache,
  target: WikiTarget,
  game: string,
): Promise<PageCandidates> {
  const seen = new Set<string>();
  const add = (titles: string[]): void => {
    for (const title of titles) {
      if (seen.size >= MAX_PAGES) return;
      // Sub-pages and the game's own overview page are all fair game; only
      // other namespaces (Talk:, File:, Category:) are not.
      if (title.includes(':')) continue;
      seen.add(title);
    }
  };

  // Categories run together: they are independent, and one missing category is
  // an empty list rather than a failure.
  const byCategory = await Promise.all(
    GUIDANCE_CATEGORIES.map(async (category) => {
      try {
        return await list(cache, target, {
          action: 'query',
          list: 'categorymembers',
          cmtitle: `Category:${category}`,
          cmlimit: '50',
          cmnamespace: '0',
        });
      } catch {
        return [];
      }
    }),
  );
  byCategory.forEach(add);
  const fromCategories = seen.size;

  let fromSearch = 0;
  if (seen.size < SPARSE) {
    try {
      const hits = await list(cache, target, {
        action: 'query',
        list: 'search',
        srsearch: game,
        srlimit: '30',
        srnamespace: '0',
      });
      add(hits);
      fromSearch = seen.size - fromCategories;
    } catch (error) {
      log.catalog.warn(
        { game, err: (error as Error).message },
        `no category pages for ${game} and its search failed too`,
      );
    }
  }

  return { titles: [...seen], fromCategories, fromSearch };
}
