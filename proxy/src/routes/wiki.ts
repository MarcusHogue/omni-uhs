/**
 * MediaWiki + IFDB passthrough routes.
 *
 *   GET /api/strategywiki?<api.php params>
 *   GET /api/wiki/:host?<api.php params>     (allowlisted hosts only)
 *   GET /api/ifdb/*path
 *
 * Query parameters are passed through after validation rather than
 * reconstructed, because MediaWiki's API surface is large and the client knows
 * what it wants. What the proxy adds is caching, the honest User-Agent,
 * `maxlag`, and the host allowlist.
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { getCache } from '../cache/index.js';
import { IFDB_BASE } from '../catalog/ifdb.js';
import { STRATEGYWIKI, apiUrl, fetchRightsInfo } from '../catalog/mediawiki.js';
import { discoverWikis } from '../catalog/discover.js';
import { gatherPages } from '../catalog/wikipages.js';
import {
  allowWiki,
  allowedWikiHosts,
  describeWiki,
  forgetWiki,
  gameTitleOf,
  imageHostsFor,
  isPinned,
  isWikiAllowed,
  siteTarget,
  targetFor,
} from '../catalog/wikis.js';
import { assertAllowed } from '../upstream/allowlist.js';

/** StrategyWiki serves its uploads from its own host. Both spellings of it. */
const STRATEGYWIKI_IMAGE_HOSTS = ['strategywiki.org', 'www.strategywiki.org'];

/** Only read actions are proxied; nothing may write to a wiki. */
const ALLOWED_ACTIONS = new Set(['query', 'parse', 'opensearch', 'expandtemplates']);

function validateParams(query: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') continue;
    if (key === 'format' || key === 'formatversion') continue;
    params[key] = value;
  }
  const action = params['action'] ?? 'query';
  if (!ALLOWED_ACTIONS.has(action)) {
    const error = new Error(`action "${action}" is not proxied`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  params['action'] = action;
  return params;
}

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/strategywiki', async (request, reply) => {
    const params = validateParams(request.query as Record<string, unknown>);
    const cache = getCache();
    const entry = await cache.fetch({
      url: apiUrl(STRATEGYWIKI.api, params),
      ttl: config.ttl.wiki,
      accept: 'application/json',
    });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(await cache.readBytes(entry));
  });

  /**
   * The bytes of one StrategyWiki picture.
   *
   * A route of its own rather than a widening of `/api/wiki/:host/image`, which
   * gates on the runtime wiki allowlist — a SQLite table that only ever holds
   * Fandom and wiki.gg hosts, because those are the only ones `allowWiki`
   * accepts. StrategyWiki is a boot-time upstream instead, so its check is the
   * fixed pair below and nothing a request can influence.
   *
   * StrategyWiki serves uploads from its own host, so the allowlist here is the
   * same one `/api/strategywiki` uses. `assertAllowed` re-runs on every redirect
   * hop inside the fetcher, so a 302 towards something internal is rejected too.
   */
  app.get('/api/strategywiki/image', async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'url is required' });

    const parsed = assertAllowed(url, STRATEGYWIKI_IMAGE_HOSTS);
    // Extension anywhere in the path, not at the end: a MediaWiki thumbnail is
    // `/w/images/thumb/a/ab/Map.png/640px-Map.png`, and the check has to pass
    // for the directory component as well as the file.
    if (!/\.(png|jpe?g|gif|webp|svg)(\/|$|\?)/i.test(parsed.pathname)) {
      return reply.code(400).send({ error: 'only image URLs are proxied here' });
    }

    const cache = getCache();
    const entry = await cache.fetch({
      url: parsed.toString(),
      ttl: config.ttl.file,
      allowlist: STRATEGYWIKI_IMAGE_HOSTS,
      accept: 'image/*',
    });
    if (!entry.contentType.startsWith('image/')) {
      return reply.code(502).send({ error: `upstream sent ${entry.contentType}, not an image` });
    }
    if (entry.size > config.imageMaxBytes) {
      return reply
        .code(413)
        .send({ error: `image is ${entry.size} bytes, over the ${config.imageMaxBytes} cap` });
    }

    return reply
      .header('content-type', entry.contentType)
      .header('content-length', String(entry.size))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(cache.stream(entry));
  });

  /** License of a wiki, so the client can show attribution before ingesting. */
  app.get('/api/strategywiki/license', async (_request, reply) => {
    const info = await fetchRightsInfo(getCache(), STRATEGYWIKI);
    return reply.send(info);
  });

  /**
   * Look for a wiki about a game.
   *
   * Deliberately a GET with no side effects: this only *offers* hosts. Nothing
   * becomes reachable until `POST /api/wiki/allow` says so.
   */
  app.get('/api/wiki/discover', async (request, reply) => {
    const { q } = request.query as { q?: string };
    const query = (q ?? '').trim();
    if (query.length < 2) {
      return reply.code(400).send({ error: 'q must be at least 2 characters' });
    }
    return reply
      .header('cache-control', 'no-store')
      .send(await discoverWikis(getCache(), query));
  });

  /** The wikis this deployment may read, and where each came from. */
  app.get('/api/wiki/allow', async (_request, reply) => {
    const cache = getCache();
    const wikis = await Promise.all(
      allowedWikiHosts(cache).map(async (host) => {
        try {
          const site = await describeWiki(cache, host);
          return { ...site, pinned: isPinned(host) };
        } catch (error) {
          // An allowlisted wiki that will not answer is still allowlisted, and
          // saying so beats dropping it silently from the list.
          return { host, pinned: isPinned(host), error: (error as Error).message };
        }
      }),
    );
    return reply.header('cache-control', 'no-store').send({ wikis });
  });

  /**
   * Add a wiki, live.
   *
   * The allowlist is the SSRF boundary, so this is bounded rather than open:
   * `allowWiki` accepts `*.fandom.com` and `*.wiki.gg` and nothing else, and it
   * verifies the host is a real MediaWiki before recording it. Every other
   * upstream still has to be named in `UPSTREAM_ALLOWLIST` at boot.
   */
  app.post('/api/wiki/allow', async (request, reply) => {
    const { host } = (request.body ?? {}) as { host?: string };
    if (!host) return reply.code(400).send({ error: 'host is required' });
    try {
      const site = await allowWiki(getCache(), host);
      return reply.send({ ...site, pinned: isPinned(site.host) });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 502;
      // A 400 is our own refusal and already says why; a 404 means the guess
      // was simply wrong, which is not an error worth dressing up.
      if (status === 400) return reply.code(400).send({ error: (error as Error).message });
      if (status === 404) return reply.code(400).send({ error: `no wiki answered at ${host}` });
      return reply
        .code(status)
        .send({ error: `could not reach ${host}: ${(error as Error).message}` });
    }
  });

  app.delete('/api/wiki/allow/:host', async (request, reply) => {
    const { host } = request.params as { host: string };
    if (!forgetWiki(getCache(), host)) {
      return reply.code(400).send({
        error: `${host} comes from WIKI_ALLOWLIST and cannot be removed from the app`,
        hint: 'edit WIKI_ALLOWLIST and restart to change it',
      });
    }
    return reply.send({ host: host.toLowerCase(), removed: true });
  });

  /**
   * What we know about an allowlisted wiki: its name, its licence, and whether
   * that licence makes it personal-use-only. The generic replacement for
   * `/api/strategywiki/license`, which only ever worked for one site.
   */
  app.get('/api/wiki/:host/site', async (request, reply) => {
    const { host } = request.params as { host: string };
    if (!isWikiAllowed(getCache(), host)) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it in Settings, or to WIKI_ALLOWLIST',
      });
    }
    return reply.send(await describeWiki(getCache(), host.toLowerCase()));
  });

  /**
   * The pages of a wiki worth downloading as one game.
   *
   * Resolved here rather than in the browser because it is several list calls
   * that all cache, and because "which pages of this wiki are guidance" is a
   * question about the wiki, not about the client asking.
   */
  app.get('/api/wiki/:host/pages', async (request, reply) => {
    const { host } = request.params as { host: string };
    const cache = getCache();
    if (!isWikiAllowed(cache, host)) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it in Settings, or to WIKI_ALLOWLIST',
      });
    }
    const lower = host.toLowerCase();
    const site = await describeWiki(cache, lower);
    const game = gameTitleOf(site.sitename, lower);
    const candidates = await gatherPages(cache, siteTarget(site), game);
    return reply.send({ host: lower, game, ...candidates });
  });

  /**
   * The bytes of one picture from an allowlisted wiki.
   *
   * This is the only route that takes an absolute URL from the client and
   * fetches it, so the checks are stacked deliberately and all of them matter:
   *
   * 1. the wiki itself must be allowlisted;
   * 2. the URL's host must be one of *that wiki's* image hosts, which for
   *    Fandom means its CDN and for wiki.gg means itself — never the global
   *    `UPSTREAM_ALLOWLIST`;
   * 3. the path must name a picture;
   * 4. what comes back must actually be an image, and must be under the cap.
   *
   * `assertAllowed` re-runs on every redirect hop inside the fetcher, so a 302
   * towards something internal is rejected there too.
   *
   * The size cap is applied after the fetch, not before: the cache streams to
   * disk and does not expose `content-length` mid-flight. It stops an
   * oversized picture being served and stored in the browser, not from
   * touching the proxy's cache directory — which is bounded by the allowlist
   * above being the wiki's own CDN rather than the open internet.
   */
  app.get('/api/wiki/:host/image', async (request, reply) => {
    const { host } = request.params as { host: string };
    const { url } = request.query as { url?: string };
    const cache = getCache();
    if (!isWikiAllowed(cache, host)) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it in Settings, or to WIKI_ALLOWLIST',
      });
    }
    if (!url) return reply.code(400).send({ error: 'url is required' });

    const site = await describeWiki(cache, host.toLowerCase());
    const parsed = assertAllowed(url, imageHostsFor(site));
    // Extension *anywhere* in the path, not at the end: a Fandom thumbnail is
    // `/…/Door.png/revision/latest/scale-to-width-down/640`, so `endsWith` here
    // would reject every real thumbnail URL the API hands out.
    if (!/\.(png|jpe?g|gif|webp|svg)(\/|$|\?)/i.test(parsed.pathname)) {
      return reply.code(400).send({ error: 'only image URLs are proxied here' });
    }

    const entry = await cache.fetch({
      url: parsed.toString(),
      ttl: config.ttl.file,
      allowlist: imageHostsFor(site),
      accept: 'image/*',
    });
    if (!entry.contentType.startsWith('image/')) {
      return reply.code(502).send({ error: `upstream sent ${entry.contentType}, not an image` });
    }
    if (entry.size > config.imageMaxBytes) {
      return reply
        .code(413)
        .send({ error: `image is ${entry.size} bytes, over the ${config.imageMaxBytes} cap` });
    }

    return reply
      .header('content-type', entry.contentType)
      .header('content-length', String(entry.size))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(cache.stream(entry));
  });

  app.get('/api/wiki/:host', async (request, reply) => {
    const { host } = request.params as { host: string };
    if (!isWikiAllowed(getCache(), host)) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it in Settings, or to WIKI_ALLOWLIST',
      });
    }
    const params = validateParams(request.query as Record<string, unknown>);

    // The api.php path is read from the wiki itself rather than guessed. The
    // guess used to be "Fandom is /api.php, everyone else /w/api.php", which
    // 404s on every wiki.gg wiki and on Fandom's language wikis.
    const cache = getCache();
    const target = await targetFor(cache, host.toLowerCase());
    const entry = await cache.fetch({
      url: apiUrl(target.api, params),
      ttl: config.ttl.wiki,
      allowlist: target.allowlist ?? [host.toLowerCase()],
      accept: 'application/json',
    });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(await cache.readBytes(entry));
  });

  app.get('/api/ifdb/*', async (request, reply) => {
    const path = (request.params as Record<string, string>)['*'] ?? '';
    const search = request.raw.url?.includes('?')
      ? request.raw.url.slice(request.raw.url.indexOf('?'))
      : '';
    const target = new URL(path.replace(/^\/+/, '') + search, IFDB_BASE);
    const parsed = assertAllowed(target.toString(), ['ifdb.org']);

    const cache = getCache();
    const entry = await cache.fetch({
      url: parsed.toString(),
      ttl: config.ttl.search,
      accept: 'application/json, text/html;q=0.5',
    });
    return reply
      .header('content-type', entry.contentType)
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(cache.stream(entry));
  });
}
