/**
 * The only place in the service that talks to the internet.
 *
 * Redirects are followed manually so the allowlist can be re-checked on every
 * hop; 429/503 with a `Retry-After` parks and retries once rather than
 * hammering; every request is capped by the per-host concurrency limiter and a
 * timeout.
 */

import { config } from '../config.js';
import { UpstreamRejected, assertAllowed } from './allowlist.js';
import { HostLimiter } from './limiter.js';

const limiter = new HostLimiter(config.perHostConcurrency);

export interface UpstreamRequest {
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Overrides the default allowlist (used by /api/wiki/:host). */
  allowlist?: readonly string[];
  accept?: string;
}

/**
 * Explain a refusal that no amount of retrying will fix.
 *
 * Cloudflare's managed challenge (`cf-mitigated: challenge`) is a JavaScript +
 * browser-fingerprint test. An HTTP client cannot pass it from any IP, with any
 * User-Agent — verified against StrategyWiki with an honest UA, a browser UA, a
 * full set of browser headers, and no UA at all. Saying "Upstream responded
 * 403" invites the reader to go looking for a misconfiguration that is not
 * there, so say what it actually is.
 */
export function describeUpstreamRejection(host: string, response: Response): string | null {
  if (response.status !== 403) return null;
  if (response.headers.get('cf-mitigated') !== 'challenge') return null;
  return (
    `${host} is behind a Cloudflare managed challenge, which only a real ` +
    `browser can pass — a server cannot read it at all. This is the site ` +
    `owner's setting, not a misconfiguration here.`
  );
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function once(request: UpstreamRequest, url: URL): Promise<Response> {
  const allowlist = request.allowlist ?? config.upstreamAllowlist;
  const headers: Record<string, string> = {
    'user-agent': config.userAgent,
    'accept-encoding': 'gzip, deflate',
    ...(request.accept ? { accept: request.accept } : {}),
    ...request.headers,
  };

  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        method: request.method ?? 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new UpstreamError(
        `Upstream request failed: ${(error as Error).message}`,
        502,
      );
    }
    clearTimeout(timer);

    // Only actual redirects — 304 Not Modified lives in the 3xx range too and
    // must be handed back to the caller so conditional requests work.
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new UpstreamError('Redirect without a Location header', 502);
      }
      // Re-validate on every hop: this is the SSRF check that matters.
      const next = new URL(location, current);
      current = assertAllowed(next.toString(), allowlist);
      continue;
    }

    return response;
  }
  throw new UpstreamError('Too many redirects', 502);
}

/**
 * Fetch an upstream URL. The response body is *not* buffered — callers stream
 * it, so multi-megabyte zips never sit in memory.
 */
export async function fetchUpstream(request: UpstreamRequest): Promise<Response> {
  const allowlist = request.allowlist ?? config.upstreamAllowlist;
  const url = assertAllowed(request.url, allowlist);

  return limiter.run(url.hostname, async () => {
    let response = await once(request, url);

    if (response.status === 429 || response.status === 503) {
      const wait = parseRetryAfter(response.headers.get('retry-after'));
      if (wait !== null && wait <= config.maxRetryAfterMs) {
        await response.body?.cancel();
        await sleep(wait);
        response = await once(request, url);
      }
    }

    return response;
  });
}

export { UpstreamRejected };
