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
  meta?: {
    year?: number;
    platform?: string;
    complete?: boolean;
    size?: number;
    date?: string;
    license?: string;
    personalUseOnly?: boolean;
  };
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
  /** Named in WIKI_ALLOWLIST, so the app cannot remove it. */
  pinned?: boolean;
  /** Set when an allowlisted wiki would not answer. */
  error?: string;
}

/** The pages of a wiki that carry guidance, resolved by the proxy. */
export interface WikiPageCandidates {
  host: string;
  game: string;
  titles: string[];
  /** How many titles each signal contributed — "main page", "categories", … */
  sources: Record<string, number>;
  /** The wiki was too large to enumerate fully. */
  truncated: boolean;
  /** Distinct pages considered before truncating to the cap. */
  considered: number;
}

/** A wiki the proxy found and verified, offered for adding. */
export interface WikiCandidate extends WikiSite {
  allowed: boolean;
  pinned: boolean;
}

export interface DiscoveryResult {
  query: string;
  candidates: WikiCandidate[];
  probed: string[];
}

/** What the registry is offering, per image. */
export interface ImageRelease {
  name: string;
  reference: string;
  /** `false` means a newer image exists; `null` means it could not be settled. */
  current: boolean | null;
  /** The published build's name, when the image declares one. */
  available: string | null;
  running: string | null;
  /** Short hash of the published manifest — the image's identity without a label. */
  digest: string | null;
  error?: string;
}

export interface ReleaseStatus {
  enabled: boolean;
  running: string;
  images: ImageRelease[];
  checkedAt: string | null;
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

/** A request that changes something. Only the wiki allowlist uses these. */
async function sendJson<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the hint proxy — you may be offline.', 0);
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      response.status,
      payload.code,
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

/**
 * One wiki, as the download layer needs to talk to it.
 *
 * Reading a wiki is two calls — an API query and a picture fetch — and until now
 * both were reached by passing a hostname to `api.wiki`/`api.wikiImage`. That
 * only ever worked because every wiki went through the same route. StrategyWiki
 * does not: it is bot-challenged at the proxy and falls back to the browser, so
 * a hostname is no longer enough to say *how* to reach a wiki.
 *
 * Passing the pair around instead lets `expandTemplates` and `fetchImages` work
 * against any source without knowing which, and makes them testable with a plain
 * object rather than a module mock.
 */
export interface WikiTransport {
  /** For warnings, and for the storage key. Not used to route anything. */
  host: string;
  query<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T>;
  image(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
}

/** Fandom and wiki.gg: everything through the proxy, which is allowlisted. */
export function wikiTransport(host: string): WikiTransport {
  return {
    host,
    query: (params, signal) => api.wiki(host, params, signal),
    image: (url, signal) => api.wikiImage(host, url, signal),
  };
}

export const strategyWikiTransport: WikiTransport = {
  host: 'strategywiki.org',
  query: (params, signal) => api.strategyWiki(params, signal),
  image: (url, signal) => api.strategyWikiImage(url, signal),
};

export const api = {
  search(query: string, sources?: SourceKind[], signal?: AbortSignal): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (sources && sources.length > 0) params.set('sources', sources.join(','));
    return getJson<SearchResponse>(`/api/catalog/search?${params}`, signal);
  },

  /**
   * Whether the registry holds a newer image than the one running.
   *
   * The web build is passed in because only the browser knows it — the version
   * is compiled into this bundle, not into anything the container can read.
   */
  release(webVersion: string, signal?: AbortSignal): Promise<ReleaseStatus> {
    return getJson<ReleaseStatus>(
      `/api/release?web=${encodeURIComponent(webVersion)}`,
      signal,
    );
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

  /** Which of a wiki's pages are worth downloading as one game. */
  wikiPages(host: string, signal?: AbortSignal): Promise<WikiPageCandidates> {
    return getJson<WikiPageCandidates>(
      `/api/wiki/${encodeURIComponent(host)}/pages`,
      signal,
    );
  },

  /** Name and licence of an allowlisted wiki — the licence gate's input. */
  wikiSite(host: string, signal?: AbortSignal): Promise<WikiSite> {
    return getJson<WikiSite>(`/api/wiki/${encodeURIComponent(host)}/site`, signal);
  },

  /**
   * Look for a wiki about a game. Read-only: it offers hosts, it does not make
   * any of them reachable — `allowWiki` does that.
   */
  discoverWikis(query: string, signal?: AbortSignal): Promise<DiscoveryResult> {
    return getJson<DiscoveryResult>(
      `/api/wiki/discover?q=${encodeURIComponent(query)}`,
      signal,
    );
  },

  /** Every wiki this deployment may read. */
  allowedWikis(signal?: AbortSignal): Promise<{ wikis: WikiSite[] }> {
    return getJson<{ wikis: WikiSite[] }>('/api/wiki/allow', signal);
  },

  /** Add a wiki. Live immediately — no restart, no .env. */
  async allowWiki(host: string, signal?: AbortSignal): Promise<WikiSite> {
    return sendJson<WikiSite>('POST', '/api/wiki/allow', { host }, signal);
  },

  async forgetWiki(host: string, signal?: AbortSignal): Promise<void> {
    await sendJson('DELETE', `/api/wiki/allow/${encodeURIComponent(host)}`, undefined, signal);
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

  /**
   * The bytes of one wiki picture.
   *
   * The URL comes from the wiki's own `imageinfo`, and the proxy checks it
   * against that wiki's image hosts before fetching anything — a URL from
   * anywhere else is refused there, not here.
   */
  async wikiImage(
    host: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const response = await fetch(
      `/api/wiki/${encodeURIComponent(host)}/image?url=${encodeURIComponent(url)}`,
      { signal },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `Image failed (${response.status})`, response.status);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    };
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

  /**
   * The bytes of one StrategyWiki picture.
   *
   * Proxy first, for the caching and the politeness, then the browser — the same
   * order and the same reason as `strategyWiki` above. The browser attempt is
   * expected to fail more often than it succeeds: unlike `api.php`, MediaWiki's
   * upload directory sends no `Access-Control-Allow-Origin`, so a cross-origin
   * read of the bytes is at the site's discretion and StrategyWiki may simply
   * not allow it. It costs one request to find out, and the alternative is
   * declaring pictures impossible on this source without having tried.
   *
   * Either way the failure is visible rather than silent: `fetchImages` marks
   * the node `unavailable` and the reader shows the caption and a link out.
   */
  async strategyWikiImage(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    try {
      const response = await fetch(`/api/strategywiki/image?url=${encodeURIComponent(url)}`, {
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        throw new ApiError(
          body.error ?? `Image failed (${response.status})`,
          response.status,
          body.code,
        );
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      if (!isChallengeError(error)) throw error;

      let direct: Response;
      try {
        direct = await fetch(url, { signal, credentials: 'omit', mode: 'cors' });
      } catch (cause) {
        if ((cause as Error).name === 'AbortError') throw cause;
        throw new ApiError(
          'StrategyWiki bot-challenged the proxy, and this browser is not allowed to read its images directly.',
          0,
        );
      }
      if (!direct.ok) {
        throw new ApiError(`StrategyWiki refused this browser too (${direct.status}).`, direct.status);
      }
      return {
        bytes: new Uint8Array(await direct.arrayBuffer()),
        mime: direct.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
      };
    }
  },

  /**
   * `list=allpages` run from the browser, for when the proxy is challenged.
   *
   * Collapsed to one row per game, exactly as the proxy's listing is: a game is
   * a tree of sub-pages here, and every one of its Download buttons downloads
   * the whole tree, so showing forty of them offered a choice that does not
   * exist.
   */
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
    const games = new Map<string, CatalogEntry>();
    for (const page of payload.query?.allpages ?? []) {
      const game = page.title?.split('/')[0]?.trim();
      if (!game) continue;
      const normalizedTitle = normalizeTitle(game);
      if (games.has(normalizedTitle)) continue;
      games.set(normalizedTitle, {
        sourceKind: 'strategywiki',
        title: game,
        normalizedTitle,
        ref: game,
      });
    }
    return [...games.values()];
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
