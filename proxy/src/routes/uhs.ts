/**
 * uhs-hints.com routes.
 *
 *   GET /api/uhs/file?url=<allowlisted zip URL>   stream the cached zip
 *   GET /api/uhs/catalog                          the scraped title list
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { getCache } from '../cache/index.js';
import { listUhsCatalog, refreshUhsCatalog } from '../catalog/uhs.js';
import { assertAllowed } from '../upstream/allowlist.js';

const UHS_HOSTS = ['uhs-hints.com', 'www.uhs-hints.com'];

export async function uhsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/uhs/file', async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'url is required' });

    // Narrower than the global allowlist: this route only serves UHS zips.
    const parsed = assertAllowed(url, UHS_HOSTS);
    if (!/\.zip$/i.test(parsed.pathname)) {
      return reply.code(400).send({ error: 'only .zip downloads are proxied here' });
    }

    const cache = getCache();
    const entry = await cache.fetch({
      url: parsed.toString(),
      ttl: config.ttl.file,
      accept: 'application/zip, */*;q=0.1',
    });

    return reply
      .header('content-type', 'application/zip')
      .header('content-length', String(entry.size))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(cache.stream(entry));
  });

  app.get('/api/uhs/catalog', async (request, reply) => {
    const { prefix, refresh } = request.query as { prefix?: string; refresh?: string };
    const cache = getCache();
    const result = await refreshUhsCatalog(cache, { force: refresh === '1' });
    return reply.send({
      entries: listUhsCatalog(cache, prefix ?? ''),
      total: result.entries,
      source: result.source,
      warnings: result.warnings,
    });
  });
}
