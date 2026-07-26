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
import { describeWiki, targetFor } from '../catalog/wikis.js';
import { assertAllowed } from '../upstream/allowlist.js';

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

  /** License of a wiki, so the client can show attribution before ingesting. */
  app.get('/api/strategywiki/license', async (_request, reply) => {
    const info = await fetchRightsInfo(getCache(), STRATEGYWIKI);
    return reply.send(info);
  });

  /**
   * What we know about an allowlisted wiki: its name, its licence, and whether
   * that licence makes it personal-use-only. The generic replacement for
   * `/api/strategywiki/license`, which only ever worked for one site.
   */
  app.get('/api/wiki/:host/site', async (request, reply) => {
    const { host } = request.params as { host: string };
    if (!config.wikiAllowlist.includes(host.toLowerCase())) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it to WIKI_ALLOWLIST',
      });
    }
    return reply.send(await describeWiki(getCache(), host.toLowerCase()));
  });

  app.get('/api/wiki/:host', async (request, reply) => {
    const { host } = request.params as { host: string };
    if (!config.wikiAllowlist.includes(host.toLowerCase())) {
      return reply.code(400).send({
        error: `wiki host not allowed: ${host}`,
        hint: 'add it to WIKI_ALLOWLIST',
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
