/**
 * MediaWiki sources: StrategyWiki now, Fandom/wiki.gg later.
 *
 * All calls are serial, carry the descriptive User-Agent, and pass `maxlag=5`
 * so the wiki can shed load on us rather than the other way round. Responses go
 * through the cache like everything else.
 *
 * Licensing matters here: StrategyWiki is CC-BY-SA 4.0, which requires
 * attribution, so the page URL and revision id are recorded with every
 * document. `siteinfo&siprop=rightsinfo` is used to discover the license of any
 * other wiki before ingesting it, and an `-NC` license forces
 * `personalUseOnly`.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { normalizeTitle } from './normalize.js';
import type { CatalogEntry, SourceKind } from './types.js';

export const STRATEGYWIKI_API = 'https://strategywiki.org/w/api.php';
export const STRATEGYWIKI_BASE = 'https://strategywiki.org/wiki/';

export interface WikiTarget {
  kind: SourceKind;
  /** Full api.php URL. */
  api: string;
  /** Human page prefix, used for attribution URLs. */
  pageBase: string;
  /**
   * Hosts this target may reach.
   *
   * StrategyWiki lives in the global `UPSTREAM_ALLOWLIST`, so it leaves this
   * unset. A Fandom or wiki.gg wiki does not — it is allowed by
   * `WIKI_ALLOWLIST`, a separate list the fetcher knows nothing about — so its
   * target carries the per-request override. Without this every call below is
   * rejected by `assertAllowed`, which is what kept those sources unreachable.
   */
  allowlist?: readonly string[];
}

export const STRATEGYWIKI: WikiTarget = {
  kind: 'strategywiki',
  api: STRATEGYWIKI_API,
  pageBase: STRATEGYWIKI_BASE,
};

/** The fetch options every call in this module shares. */
const fetchOptions = (target: WikiTarget, url: string, ttl: number) => ({
  url,
  ttl,
  accept: 'application/json',
  ...(target.allowlist ? { allowlist: target.allowlist } : {}),
});

/** Build an api.php URL with the politeness parameters already applied. */
export function apiUrl(api: string, params: Record<string, string>): string {
  const url = new URL(api);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  if (!url.searchParams.has('maxlag')) url.searchParams.set('maxlag', '5');
  return url.toString();
}

interface SearchPayload {
  query?: { search?: { title?: string; snippet?: string }[] };
}

/** The wiki an entry came from, for sources that span many. */
const hostOf = (target?: WikiTarget): { host?: string } => {
  if (!target?.allowlist) return {};
  try {
    return { host: new URL(target.api).hostname };
  } catch {
    return {};
  }
};

export function parseWikiSearch(
  json: string,
  kind: SourceKind,
  target?: WikiTarget,
): CatalogEntry[] {
  let payload: SearchPayload;
  try {
    payload = JSON.parse(json) as SearchPayload;
  } catch {
    return [];
  }
  const entries: CatalogEntry[] = [];
  for (const hit of payload.query?.search ?? []) {
    if (!hit.title) continue;
    // Sub-pages ("Chrono Trigger/Walkthrough") group under the game title.
    const title = hit.title.split('/')[0]!;
    entries.push({
      sourceKind: kind,
      title,
      normalizedTitle: normalizeTitle(title),
      ref: hit.title,
      ...hostOf(target),
    });
  }
  // Deduplicate: a game usually matches several of its own sub-pages.
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.sourceKind}:${entry.normalizedTitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchWiki(
  cache: Cache,
  target: WikiTarget,
  query: string,
  limit = 25,
): Promise<CatalogEntry[]> {
  const url = apiUrl(target.api, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.min(limit * 2, 50)),
    srnamespace: '0',
  });
  const result = await cache.fetch(fetchOptions(target, url, config.ttl.search));
  return parseWikiSearch(await cache.readText(result), target.kind, target).slice(0, limit);
}

interface AllPagesPayload {
  query?: { allpages?: { title?: string }[] };
}

export function parseAllPages(
  json: string,
  kind: SourceKind,
  target?: WikiTarget,
): CatalogEntry[] {
  let payload: AllPagesPayload;
  try {
    payload = JSON.parse(json) as AllPagesPayload;
  } catch {
    return [];
  }
  return (payload.query?.allpages ?? [])
    .map((page) => page.title)
    .filter((title): title is string => Boolean(title))
    .map((title) => ({
      sourceKind: kind,
      title,
      normalizedTitle: normalizeTitle(title.split('/')[0]!),
      ref: title,
      ...hostOf(target),
    }));
}

/** Browse listing: every page under a prefix, e.g. "Chrono Trigger/". */
export async function listWikiPages(
  cache: Cache,
  target: WikiTarget,
  prefix: string,
  limit = 200,
): Promise<CatalogEntry[]> {
  const url = apiUrl(target.api, {
    action: 'query',
    list: 'allpages',
    apprefix: prefix,
    aplimit: String(Math.min(limit, 500)),
    apnamespace: '0',
  });
  const result = await cache.fetch(fetchOptions(target, url, config.ttl.index));
  return parseAllPages(await cache.readText(result), target.kind, target);
}

export interface WikiPage {
  title: string;
  wikitext: string;
  revision: string | null;
  url: string;
}

interface RevisionsPayload {
  query?: {
    pages?: {
      title?: string;
      missing?: boolean;
      revisions?: { revid?: number; slots?: { main?: { content?: string } } }[];
    }[];
  };
}

/** Fetch one page's wikitext plus the revision id needed for attribution. */
export async function fetchWikitext(
  cache: Cache,
  target: WikiTarget,
  title: string,
): Promise<WikiPage | null> {
  const url = apiUrl(target.api, {
    action: 'query',
    prop: 'revisions',
    titles: title,
    rvslots: 'main',
    rvprop: 'content|ids',
  });
  const result = await cache.fetch(fetchOptions(target, url, config.ttl.wiki));
  const payload = JSON.parse(await cache.readText(result)) as RevisionsPayload;
  const page = payload.query?.pages?.[0];
  if (!page || page.missing) return null;
  const revision = page.revisions?.[0];
  return {
    title: page.title ?? title,
    wikitext: revision?.slots?.main?.content ?? '',
    revision: revision?.revid !== undefined ? String(revision.revid) : null,
    url: `${target.pageBase}${encodeURIComponent((page.title ?? title).replace(/ /g, '_'))}`,
  };
}

export interface RightsInfo {
  license: string;
  url: string;
  /** A -NC license means the content can never be exported or shared. */
  personalUseOnly: boolean;
}

interface RightsPayload {
  query?: { rightsinfo?: { url?: string; text?: string } };
}

/**
 * Read a wiki's license before ingesting anything from it (spec §6.4).
 * Anything non-commercial, or unrecognised, is treated as personal-use-only.
 */
export function parseRightsInfo(json: string): RightsInfo {
  let payload: RightsPayload;
  try {
    payload = JSON.parse(json) as RightsPayload;
  } catch {
    return { license: 'unknown', url: '', personalUseOnly: true };
  }
  const text = payload.query?.rightsinfo?.text ?? '';
  const url = payload.query?.rightsinfo?.url ?? '';
  const haystack = `${text} ${url}`.toLowerCase();

  const nonCommercial = /[^a-z]nc[^a-z]|noncommercial|non-commercial/.test(haystack);

  // Match both the URL form ("licenses/by-sa/4.0/") and the prose form
  // ("Creative Commons Attribution-ShareAlike 4.0"), which share no separators.
  const shareAlike =
    /by[^a-z0-9]{0,3}sa[^a-z0-9]/.test(haystack) ||
    /attribution[^a-z0-9]{0,3}sharealike/.test(haystack);

  let license = text || 'unknown';
  if (shareAlike) {
    const version = /(?:by[^a-z0-9]{0,3}sa|sharealike)[^0-9]{0,4}([34])\.?0?/.exec(haystack)?.[1];
    license = version ? `CC-BY-SA-${version}.0` : 'CC-BY-SA';
  }

  return {
    license,
    url,
    personalUseOnly: nonCommercial || !license.startsWith('CC-BY-SA'),
  };
}

export async function fetchRightsInfo(cache: Cache, target: WikiTarget): Promise<RightsInfo> {
  const url = apiUrl(target.api, { action: 'query', meta: 'siteinfo', siprop: 'rightsinfo' });
  const result = await cache.fetch(fetchOptions(target, url, config.ttl.index));
  return parseRightsInfo(await cache.readText(result));
}
