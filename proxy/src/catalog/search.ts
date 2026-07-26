/**
 * Unified search across every enabled source.
 *
 * Sources run in parallel and are merged by normalized title, so a game that
 * exists in three places shows up once with three badges. A source that fails
 * or times out contributes a line to `warnings[]` and nothing else — a dead
 * wiki must never turn a working search into an error.
 */

import { config } from '../config.js';
import { log, since } from '../log.js';
import type { Cache } from '../cache/index.js';
import { searchIfArchive, refreshIfArchiveCatalog } from './ifarchive.js';
import { searchIfdb } from './ifdb.js';
import { STRATEGYWIKI, searchWiki } from './mediawiki.js';
import { allowlistedHosts, targetFor } from './wikis.js';
import { refreshUhsCatalog, searchUhsCatalog } from './uhs.js';
import { normalizeTitle } from './normalize.js';
import type { CatalogEntry, CatalogGroup, SearchResponse, SourceKind } from './types.js';

/** Every source the fan-out knows how to query. */
export const SEARCHABLE_SOURCES: SourceKind[] = [
  'uhs',
  'ifarchive',
  'strategywiki',
  'ifdb',
  'fandom',
  'wikigg',
];

/**
 * How many wikis one platform will be asked about in a single search.
 *
 * Each is a separate host, so they run in parallel — but every one is a real
 * request to someone else's server, and a long WIKI_ALLOWLIST should not turn
 * one keystroke into thirty of them.
 */
const WIKI_SEARCH_MAX = 8;

/**
 * Search every allowlisted wiki on a platform.
 *
 * Each wiki gets its own slice of the budget rather than sharing one: the outer
 * `withTimeout` in `searchCatalog` covers the whole source, so without this a
 * single slow wiki would starve the rest and the source would return nothing.
 */
async function searchPlatform(
  cache: Cache,
  kind: SourceKind,
  query: string,
): Promise<CatalogEntry[]> {
  const hosts = allowlistedHosts(cache, kind).slice(0, WIKI_SEARCH_MAX);
  if (hosts.length === 0) return [];

  const perWiki = Math.max(2000, Math.floor(config.searchTimeoutMs * 0.8));
  const results = await Promise.all(
    hosts.map(async (host) => {
      try {
        const target = await targetFor(cache, host);
        return await withTimeout(host, perWiki, searchWiki(cache, target, query, 10));
      } catch (error) {
        // One unreachable wiki must not fail the platform. It is logged rather
        // than surfaced: the user allowlisted a host, not a promise it is up.
        log.search.warn({ host, kind, err: (error as Error).message }, `${host} search failed`);
        return [] as CatalogEntry[];
      }
    }),
  );
  return results.flat();
}

/**
 * What a search hits when the caller does not say.
 *
 * StrategyWiki is deliberately absent: it sits behind a Cloudflare managed
 * challenge that no HTTP client can pass (see `describeUpstreamRejection`), so
 * including it by default means every single search returns a warning about a
 * source that structurally cannot work. It stays fully implemented and is still
 * queried when asked for explicitly — `?sources=strategywiki` — or when
 * SEARCH_SOURCES lists it, so nothing is lost the day that changes.
 */
export const DEFAULT_SEARCH_SOURCES: SourceKind[] = config.searchSources;

const MAX_GROUPS = 50;

export interface SourceInfo {
  kind: SourceKind;
  /** On by default, i.e. searched when the request names no sources. */
  enabledByDefault: boolean;
  /** Shown next to the chip when there is something the user should know. */
  note?: string;
  /** For the multi-wiki platforms: which wikis are allowlisted. */
  hosts?: string[];
}

const SOURCE_NOTES: Partial<Record<SourceKind, string>> = {
  strategywiki:
    'Behind a Cloudflare managed challenge that only a real browser can pass, ' +
    'so a server cannot read it. Off by default; turn it on to try anyway.',
  ifdb: 'A catalogue, not a hint source — it tells you a game exists, but the ' +
    'hints come from UHS or the IF Archive.',
  fandom:
    'Reference wikis, not walkthroughs. Only the wikis you list in ' +
    'WIKI_ALLOWLIST are searched, and pages are re-shaped so answers reveal ' +
    'one at a time rather than all at once.',
  wikigg:
    'Reference wikis, not walkthroughs. Only the wikis you list in ' +
    'WIKI_ALLOWLIST are searched. Many are CC-BY-NC-SA, which marks them ' +
    'personal-use-only.',
};

/** What the UI needs to render the source chips without hard-coding policy. */
export function describeSources(cache: Cache): SourceInfo[] {
  return SEARCHABLE_SOURCES.map((kind) => {
    const note = SOURCE_NOTES[kind];
    // The wiki platforms do nothing until a host is allowlisted, so the UI
    // needs to know which ones exist — and to say so when there are none.
    const hosts = kind === 'fandom' || kind === 'wikigg' ? allowlistedHosts(cache, kind) : [];
    return {
      kind,
      enabledByDefault: DEFAULT_SEARCH_SOURCES.includes(kind),
      ...(note ? { note } : {}),
      ...(hosts.length > 0 ? { hosts } : {}),
    };
  });
}

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
  fandom: (cache, query) => searchPlatform(cache, 'fandom', query),
  wikigg: (cache, query) => searchPlatform(cache, 'wikigg', query),
};

/**
 * Pick the nicest display title in a group.
 *
 * Prefer a title with real word breaks over a filename stem — "Beyond Zork"
 * beats "beyondzork" even though the latter may be longer — and among equals
 * prefer the more descriptive one.
 */
function bestTitle(entries: CatalogEntry[]): string {
  const rank = (title: string): number => {
    const words = title.trim().split(/\s+/).length;
    const looksLikeFilename = !title.includes(' ') && /^[a-z0-9._-]+$/.test(title);
    return (looksLikeFilename ? -1000 : 0) + words * 100 + Math.min(title.length, 60);
  };
  return entries.reduce(
    (best, entry) => (rank(entry.title) > rank(best) ? entry.title : best),
    entries[0]?.title ?? '',
  );
}

/**
 * Grouping key.
 *
 * Spaces are dropped so a filename stem lands with its properly-spelled
 * sibling: the IF Archive's `beyondzork.sol` becomes "beyondzork", which is the
 * same game as UHS's "Beyond Zork" and should not be a second result. Two
 * genuinely different games whose titles differ only in spacing would collide,
 * which has not come up and would be the lesser problem anyway.
 */
function groupKey(normalizedTitle: string): string {
  return normalizedTitle.replace(/\s+/g, '');
}

/** How useful a source is when the same game appears in several. */
const SOURCE_WEIGHT: Record<SourceKind, number> = {
  uhs: 30, // curated titles, real progressive hints
  ifarchive: 20, // the real thing for IF, but filename-derived titles
  strategywiki: 15,
  ifdb: 5, // metadata only — you cannot read hints from it
  fandom: 10,
  wikigg: 10,
};

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * Relevance score for one group against the query.
 *
 * The old ordering was "exact match, then whichever group had the most
 * entries" — which floated any game with four IF Archive files above the one
 * you actually typed. Matching quality now dominates, and everything else is a
 * tie-breaker.
 */
/**
 * How well the title matches the query, ignoring everything else.
 *
 * `NO_MATCH` means the query does not appear in the title at all. Only IFDB
 * produces those — its search is fuzzy, so a query for "trinity" comes back
 * with "Unity!" and "Masterclass" — and they are dropped when anything real
 * matched.
 */
export const NO_MATCH = 50;

export function baseScore(normalizedTitle: string, normalizedQuery: string): number {
  const title = groupKey(normalizedTitle);
  const query = groupKey(normalizedQuery);
  if (title === query) return 1000;
  if (title.startsWith(query)) return 700;
  if (new RegExp(`\\b${escapeRegExp(normalizedQuery)}`).test(normalizedTitle)) return 500;
  if (title.includes(query)) return 250;
  return NO_MATCH;
}

export function scoreGroup(group: CatalogGroup, normalizedQuery: string): number {
  const title = groupKey(group.normalizedTitle);
  const query = groupKey(normalizedQuery);
  const spacedTitle = group.normalizedTitle;
  const queryWords = words(normalizedQuery);

  let score = baseScore(group.normalizedTitle, normalizedQuery);

  // Every query word present as a whole word is worth more than the same
  // letters buried in a longer string.
  const matchedWords = queryWords.filter((word) =>
    new RegExp(`\\b${escapeRegExp(word)}\\b`).test(spacedTitle),
  ).length;
  if (queryWords.length > 0) score += (matchedWords / queryWords.length) * 150;

  // Prefer the tighter match: "Zork" over "Zork: The Undiscovered Underground".
  score -= Math.min(80, Math.max(0, title.length - query.length) * 2);

  // Where you can actually read the hints matters more than how many hits.
  score += Math.max(...group.entries.map((e) => SOURCE_WEIGHT[e.sourceKind] ?? 0));
  const distinctSources = new Set(group.entries.map((e) => e.sourceKind)).size;
  score += Math.min(distinctSources - 1, 2) * 8;

  // A group that is only an IFDB row cannot be downloaded at all, so it should
  // never sit above something you can actually read — the penalty is bigger
  // than the gap between any two match qualities below "exact".
  if (group.entries.every((e) => e.sourceKind === 'ifdb')) score -= 200;

  return score;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Within a group, list the sources you can actually read first. */
function orderEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort(
    (a, b) =>
      (SOURCE_WEIGHT[b.sourceKind] ?? 0) - (SOURCE_WEIGHT[a.sourceKind] ?? 0) ||
      a.ref.localeCompare(b.ref),
  );
}

export function groupEntries(entries: CatalogEntry[], query: string): CatalogGroup[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry.normalizedTitle);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  const normalizedQuery = normalizeTitle(query);

  const scored = [...groups.values()]
    .map((list) => {
      const title = bestTitle(list);
      return {
        normalizedTitle: normalizeTitle(title),
        title,
        entries: orderEntries(list),
      };
    })
    .map((group) => ({
      group,
      score: scoreGroup(group, normalizedQuery),
      base: baseScore(group.normalizedTitle, normalizedQuery),
    }));

  // Once something genuinely matches, fuzzy near-misses are noise, not results.
  // They are kept when nothing matched, so a typo still returns *something*.
  const matched = scored.some((row) => row.base > NO_MATCH);
  const kept = matched ? scored.filter((row) => row.base > NO_MATCH) : scored;

  return kept
    .sort((a, b) => b.score - a.score || a.group.title.localeCompare(b.group.title))
    .slice(0, MAX_GROUPS)
    .map(({ group }) => group);
}

export async function searchCatalog(
  cache: Cache,
  query: string,
  sources: SourceKind[] = DEFAULT_SEARCH_SOURCES,
): Promise<SearchResponse> {
  const warnings: string[] = [];
  const challenged: SourceKind[] = [];
  const enabled = sources.filter((source) => RUNNERS[source] !== undefined);

  const started = performance.now();
  const counts: Record<string, number> = {};

  const results = await Promise.all(
    enabled.map(async (source) => {
      try {
        const entries = await withTimeout(
          source,
          config.searchTimeoutMs,
          RUNNERS[source]!(cache, query),
        );
        counts[source] = entries.length;
        return entries;
      } catch (error) {
        counts[source] = -1;
        warnings.push(`${source}: ${(error as Error).message}`);
        if ((error as { upstreamChallenge?: boolean }).upstreamChallenge) challenged.push(source);
        return [] as CatalogEntry[];
      }
    }),
  );

  const groups = groupEntries(results.flat(), query);

  // One line per search, with the per-source hit counts. A source quietly
  // returning nothing looks identical to a working one from the UI, so this is
  // where you find out that e.g. the IF Archive index never refreshed. A count
  // of -1 means that source failed and named itself in `warnings`.
  log.search.info(
    { query, sources: counts, groups: groups.length, ms: since(started), challenged },
    `search "${query}" -> ${groups.length} groups`,
  );

  return {
    query,
    groups,
    warnings,
    sources: enabled,
    challenged,
  };
}
