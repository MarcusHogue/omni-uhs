/**
 * IFDB — game metadata and search for interactive fiction.
 *
 * IFDB sits behind Cloudflare and answers 403 (error 1010) to requests without
 * a real User-Agent, so the honest one from config is mandatory here rather
 * than merely polite. Volume is kept low: results are cached and the search
 * endpoint is only called on an explicit user query.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { normalizeTitle } from './normalize.js';
import type { CatalogEntry } from './types.js';

export const IFDB_BASE = 'https://ifdb.org/';

interface IfdbGame {
  tuid?: string;
  title?: string;
  author?: string;
  published?: { machine?: string };
}

export function parseIfdbSearch(json: string): CatalogEntry[] {
  let payload: { games?: IfdbGame[] };
  try {
    payload = JSON.parse(json) as { games?: IfdbGame[] };
  } catch {
    return [];
  }
  const entries: CatalogEntry[] = [];
  for (const game of payload.games ?? []) {
    if (!game.tuid || !game.title) continue;
    const meta: CatalogEntry['meta'] = {};
    const year = Number.parseInt(game.published?.machine ?? '', 10);
    if (Number.isFinite(year)) meta.year = year;
    entries.push({
      sourceKind: 'ifdb',
      title: game.title,
      normalizedTitle: normalizeTitle(game.title),
      ref: game.tuid,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }
  return entries;
}

export async function searchIfdb(
  cache: Cache,
  query: string,
  limit = 25,
): Promise<CatalogEntry[]> {
  const url = `${IFDB_BASE}search?searchbar=${encodeURIComponent(query)}&json`;
  const result = await cache.fetch({
    url,
    ttl: config.ttl.search,
    accept: 'application/json',
  });
  return parseIfdbSearch(await cache.readText(result)).slice(0, limit);
}
