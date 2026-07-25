/**
 * Configuration, all from the environment (spec §8).
 *
 * Nothing here has a surprising default: the allowlist is the security
 * boundary, so it is explicit, and the User-Agent is honest about who is
 * calling and why.
 */

import { resolve } from 'node:path';

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const list = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
};

const HOUR = 3600;

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

const level = (value: string | undefined): LogLevel => {
  const wanted = (value ?? '').trim().toLowerCase() as LogLevel;
  if (LEVELS.includes(wanted)) return wanted;
  // Tests build caches and apps constantly; their logs are noise, not activity.
  return process.env['NODE_ENV'] === 'test' ? 'silent' : 'info';
};

export const config = {
  port: int(process.env['PORT'], 8080),
  host: process.env['HOST'] ?? '0.0.0.0',
  cacheDir: resolve(process.env['CACHE_DIR'] ?? '/data/cache'),

  /**
   * How much shows up in `docker logs`.
   *
   * `info` is the useful default: one line per request, plus every upstream
   * fetch, catalog refresh and search. `debug` adds cache hits and the
   * individual decisions behind them, which is what you want when something is
   * being served stale or refetched more than it should be.
   */
  logLevel: level(process.env['LOG_LEVEL']),

  /**
   * Whether the per-request access line is emitted at all. The health check
   * is always excluded — it fires every 30s and says nothing.
   */
  logRequests: process.env['LOG_REQUESTS'] !== 'false',

  /**
   * Hostname allowlist. Enforced after URL parsing and again on every redirect
   * hop — this is the SSRF boundary, not a convenience filter.
   */
  upstreamAllowlist: list(process.env['UPSTREAM_ALLOWLIST'], [
    'uhs-hints.com',
    'www.uhs-hints.com',
    'strategywiki.org',
    'www.strategywiki.org',
    'ifdb.org',
    'ifarchive.org',
    'www.ifarchive.org',
  ]),

  /** Additional MediaWiki hosts reachable through /api/wiki/:host (phase 2). */
  wikiAllowlist: list(process.env['WIKI_ALLOWLIST'], []),

  userAgent:
    process.env['USER_AGENT'] ??
    'OmniUHS/1.0 (+personal use; contact: set USER_AGENT to your address)',

  /** Per-class cache lifetimes, in seconds. */
  ttl: {
    /** Hint files never change; the site has been dormant since ~2015. */
    file: int(process.env['CACHE_TTL_FILE'], 365 * 24 * HOUR),
    catalog: int(process.env['CACHE_TTL_CATALOG'], 24 * HOUR),
    wiki: int(process.env['CACHE_TTL_WIKI'], 12 * HOUR),
    search: int(process.env['CACHE_TTL_SEARCH'], 6 * HOUR),
    index: int(process.env['CACHE_TTL_INDEX'], 24 * HOUR),
  },

  /** Politeness: at most this many in-flight requests per upstream host. */
  perHostConcurrency: int(process.env['UPSTREAM_CONCURRENCY'], 2),

  /** Give up on a single upstream request after this long. */
  requestTimeoutMs: int(process.env['UPSTREAM_TIMEOUT_MS'], 60_000),

  /** Cap on how long we will park for a Retry-After before giving up. */
  maxRetryAfterMs: int(process.env['MAX_RETRY_AFTER_MS'], 60_000),

  /** Search fan-out budget; a slow source must not stall the whole response. */
  searchTimeoutMs: int(process.env['SEARCH_TIMEOUT_MS'], 8_000),

  /**
   * Sources a search hits when the request does not name any.
   *
   * StrategyWiki is left out of the default because it answers every
   * server-side request with a Cloudflare managed challenge, so including it
   * only produces a warning on every search. Add it back with
   * SEARCH_SOURCES=uhs,ifarchive,ifdb,strategywiki if that ever changes; it can
   * always be requested explicitly regardless.
   */
  searchSources: list(process.env['SEARCH_SOURCES'], [
    'uhs',
    'ifarchive',
    'ifdb',
  ]) as ('uhs' | 'ifarchive' | 'ifdb' | 'strategywiki' | 'fandom' | 'wikigg')[],
} as const;

export type Config = typeof config;
