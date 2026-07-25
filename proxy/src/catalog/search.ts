/**
 * Unified search across every enabled source.
 *
 * Sources run in parallel and are merged by normalized title, so a game that
 * exists in three places shows up once with three badges. A source that fails
 * or times out contributes a line to `warnings[]` and nothing else — a dead
 * wiki must never turn a working search into an error.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { searchIfArchive, refreshIfArchiveCatalog } from './ifarchive.js';
import { searchIfdb } from './ifdb.js';
import { STRATEGYWIKI, searchWiki } from './mediawiki.js';
import { refreshUhsCatalog, searchUhsCatalog } from './uhs.js';
import type { CatalogEntry, CatalogGroup, SearchResponse, SourceKind } from './types.js';

export const SEARCHABLE_SOURCES: SourceKind[] = ['uhs', 'ifarchive', 'strategywiki', 'ifdb'];

const MAX_GROUPS = 50;

/** Cap a source's work so one slow upstream cannot stall the response. */
async function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SourceRunner = (cache: Cache, query: string) => Promise<CatalogEntry[]>;

const RUNNERS: Record<SourceKind, SourceRunner | undefined> = {
  uhs: async (cache, query) => {
    await refreshUhsCatalog(cache);
    return searchUhsCatalog(cache, query);
  },
  ifarchive: async (cache, query) => {
    await refreshIfArchiveCatalog(cache);
    return searchIfArchive(cache, query);
  },
  strategywiki: (cache, query) => searchWiki(cache, STRATEGYWIKI, query),
  ifdb: (cache, query) => searchIfdb(cache, query),
  fandom: undefined,
  wikigg: undefined,
};

/**
 * Pick the nicest display title in a group: the longest one wins, since
 * "Zork I: The Great Underground Empire" is more useful than "Zork I".
 */
function bestTitle(entries: CatalogEntry[]): string {
  return entries.reduce((best, entry) => (entry.title.length > best.length ? entry.title : best), '');
}

export function groupEntries(entries: CatalogEntry[], query: string): CatalogGroup[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.normalizedTitle);
    if (list) list.push(entry);
    else groups.set(entry.normalizedTitle, [entry]);
  }

  const normalizedQuery = query.toLowerCase().trim();
  return [...groups.entries()]
    .map(([normalizedTitle, list]) => ({
      normalizedTitle,
      title: bestTitle(list),
      entries: list,
    }))
    .sort((a, b) => {
      // Exact matches first, then more sources, then shorter titles.
      const aExact = a.normalizedTitle === normalizedQuery ? 0 : 1;
      const bExact = b.normalizedTitle === normalizedQuery ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.entries.length !== b.entries.length) return b.entries.length - a.entries.length;
      return a.title.length - b.title.length;
    })
    .slice(0, MAX_GROUPS);
}

export async function searchCatalog(
  cache: Cache,
  query: string,
  sources: SourceKind[] = SEARCHABLE_SOURCES,
): Promise<SearchResponse> {
  const warnings: string[] = [];
  const enabled = sources.filter((source) => RUNNERS[source] !== undefined);

  const results = await Promise.all(
    enabled.map(async (source) => {
      try {
        return await withTimeout(source, config.searchTimeoutMs, RUNNERS[source]!(cache, query));
      } catch (error) {
        warnings.push(`${source}: ${(error as Error).message}`);
        return [] as CatalogEntry[];
      }
    }),
  );

  return {
    query,
    groups: groupEntries(results.flat(), query),
    warnings,
    sources: enabled,
  };
}
