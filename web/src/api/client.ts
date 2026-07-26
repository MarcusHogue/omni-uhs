/**
 * Typed client for the proxy. The only module in the app that knows the
 * network exists — everything downstream of a completed download works from
 * IndexedDB alone.
 */

import type { SourceKind } from '../parser/ast';
import { normalizeTitle } from '../parser/id';

export interface CatalogEntry {
  sourceKind: SourceKind;
  title: string;
  normalizedTitle: string;
  ref: string;
  /** Which wiki, for the multi-wiki sources. Unset elsewhere. */
  host?: string;
  meta?: { year?: number; platform?: string; complete?: boolean; size?: number; date?: string };
}

export interface CatalogGroup {
  normalizedTitle: string;
  title: string;
  entries: CatalogEntry[];
}

export interface SearchResponse {
  query: string;
  groups: CatalogGroup[];
  warnings: string[];
  sources: SourceKind[];
  /** Sources that bot-challenged the server; the browser may still reach them. */
  challenged?: SourceKind[];
}

/** What the proxy knows about an allowlisted wiki. */
export interface WikiSite {
  host: string;
  kind: SourceKind;
  sitename: string;
  license: string;
  licenseUrl: string;
  personalUseOnly: boolean;
  gamepedia: boolean;
}

export interface SourceInfo {
  kind: SourceKind;
  enabledByDefault: boolean;
  note?: string;
  /** For the multi-wiki platforms: which wikis WIKI_ALLOWLIST permits. */
  hosts?: string[];
}

export interface ListResponse {
  source: string;
  entries: CatalogEntry[];
  warnings: string[];
  challenged?: SourceKind[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable reason, currently only `upstream_challenge`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * True when the upstream refused *the server* with a bot challenge.
 *
 * Worth distinguishing because it is the one failure the browser might not
 * share: the challenge is aimed at datacenter traffic, and the user's own
 * connection may sail through. See `strategyWikiDirect`.
 */
export function isChallengeError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'upstream_challenge';
}

/** True when the failure is "you are offline", not "the server said no". */
export function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status === 0);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the hint proxy — you may be offline.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(
      body.error ?? `Request failed (${response.status})`,
      response.status,
      body.code,
    );
  }
  return (await response.json()) as T;
}

export const STRATEGYWIKI_API = 'https://strategywiki.org/w/api.php';
export const STRATEGYWIKI_WIKI = 'https://strategywiki.org/wiki/';

/** The page a StrategyWiki entry refers to, for opening in a real browser tab. */
export function strategyWikiPageUrl(ref: string): string {
  return `${STRATEGYWIKI_WIKI}${encodeURIComponent(ref.replace(/ /g, '_'))}`;
}

/**
 * StrategyWiki's own search page.
 *
 * The last resort when neither the proxy nor a background fetch can reach the
 * site: a *navigation* is the one request Cloudflare will issue an interactive
 * challenge for, and the one a person can actually complete.
 */
export function strategyWikiSearchUrl(query: string): string {
  return `https://strategywiki.org/w/index.php?search=${encodeURIComponent(query)}`;
}

/**
 * Query StrategyWiki from the browser instead of through the proxy.
 *
 * Cloudflare's managed challenge cannot be "handed to the user" in the way it
 * first appears: the clearance it issues is bound to the client's IP address
 * and User-Agent, so a token the phone earns is meaningless to the NAS. What
 * *can* be handed over is the request itself. MediaWiki answers anonymous
 * cross-origin calls when `origin=*` is set, so the page can talk to api.php
 * directly, from the user's own connection, with their own browser's
 * fingerprint — exactly the client Cloudflare is willing to serve.
 *
 * No credentials are sent (`origin=*` and cookies are mutually exclusive under
 * CORS), so this is an anonymous read of a public wiki and nothing more. If
 * Cloudflare challenges the browser too, this fails like any other fetch and
 * the caller offers a link to the page instead.
 */
export async function strategyWikiDirect<T>(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(STRATEGYWIKI_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('origin', '*');

  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', mode: 'cors' });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('StrategyWiki could not be reached from this browser either.', 0);
  }
  if (!response.ok) {
    throw new ApiError(
      `StrategyWiki refused this browser too (${response.status}).`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  search(query: string, sources?: SourceKind[], signal?: AbortSignal): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (sources && sources.length > 0) params.set('sources', sources.join(','));
    return getJson<SearchResponse>(`/api/catalog/search?${params}`, signal);
  },

  sources(signal?: AbortSignal): Promise<{ sources: SourceInfo[] }> {
    return getJson<{ sources: SourceInfo[] }>('/api/catalog/sources', signal);
  },

  /**
   * A MediaWiki API call against any allowlisted wiki.
   *
   * The generic form of `strategyWiki`. No browser-direct fallback: that exists
   * only because StrategyWiki bot-challenges the server, and neither Fandom nor
   * wiki.gg does on api.php.
   */
  wiki<T>(host: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return getJson<T>(
      `/api/wiki/${encodeURIComponent(host)}?${new URLSearchParams(params)}`,
      signal,
    );
  },

  /** Name and licence of an allowlisted wiki — the licence gate's input. */
  wikiSite(host: string, signal?: AbortSignal): Promise<WikiSite> {
    return getJson<WikiSite>(`/api/wiki/${encodeURIComponent(host)}/site`, signal);
  },

  /**
   * A browse listing. `host` picks the wiki for the platform sources, where
   * `source` names a platform rather than a single site.
   */
  list(
    source: string,
    prefix?: string,
    signal?: AbortSignal,
    host?: string,
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (host) params.set('host', host);
    return getJson<ListResponse>(`/api/catalog/${source}/list?${params}`, signal);
  },

  /** The zip containing a .uhs file. */
  async uhsFile(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(`/api/uhs/file?url=${encodeURIComponent(url)}`, { signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `Download failed (${response.status})`, response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  },

  async ifArchiveFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(`/api/ifarchive/${path.replace(/^\/+/, '')}`, { signal });
    if (!response.ok) throw new ApiError(`Download failed (${response.status})`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  },

  /**
   * StrategyWiki through the proxy, falling back to the browser when the proxy
   * is bot-challenged. The proxy is still tried first: it caches, it is polite,
   * and it works everywhere a challenge is not in the way.
   */
  async strategyWiki<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    try {
      return await getJson<T>(`/api/strategywiki?${new URLSearchParams(params)}`, signal);
    } catch (error) {
      if (!isChallengeError(error)) throw error;
      return strategyWikiDirect<T>(params, signal);
    }
  },

  /** `list=allpages` run from the browser, for when the proxy is challenged. */
  async listStrategyWikiDirect(
    prefix: string,
    signal?: AbortSignal,
    limit = 200,
  ): Promise<CatalogEntry[]> {
    const payload = await strategyWikiDirect<{ query?: { allpages?: { title?: string }[] } }>(
      {
        action: 'query',
        list: 'allpages',
        apprefix: prefix,
        aplimit: String(Math.min(limit, 500)),
        apnamespace: '0',
        maxlag: '5',
      },
      signal,
    );
    return (payload.query?.allpages ?? [])
      .map((page) => page.title)
      .filter((title): title is string => Boolean(title))
      .map((title) => ({
        sourceKind: 'strategywiki' as const,
        title,
        normalizedTitle: normalizeTitle(title.split('/')[0]!),
        ref: title,
      }));
  },

  /** `list=search` run from the browser, for when the proxy is challenged. */
  async searchStrategyWikiDirect(
    query: string,
    signal?: AbortSignal,
    limit = 25,
  ): Promise<CatalogEntry[]> {
    const payload = await strategyWikiDirect<{
      query?: { search?: { title?: string }[] };
    }>(
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(Math.min(limit * 2, 50)),
        srnamespace: '0',
        maxlag: '5',
      },
      signal,
    );

    const seen = new Set<string>();
    const entries: CatalogEntry[] = [];
    for (const hit of payload.query?.search ?? []) {
      if (!hit.title) continue;
      // Sub-pages ("Chrono Trigger/Walkthrough") belong to the game, not beside it.
      const title = hit.title.split('/')[0]!;
      const normalizedTitle = normalizeTitle(title);
      if (seen.has(normalizedTitle)) continue;
      seen.add(normalizedTitle);
      entries.push({ sourceKind: 'strategywiki', title, normalizedTitle, ref: hit.title });
      if (entries.length >= limit) break;
    }
    return entries;
  },

  license(): Promise<{ license: string; url: string; personalUseOnly: boolean }> {
    return getJson('/api/strategywiki/license');
  },
};
