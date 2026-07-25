/**
 * IF Archive routes.
 *
 *   GET /api/ifarchive/*path   stream any allowlisted archive file
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { getCache } from '../cache/index.js';
import { IFARCHIVE_BASE } from '../catalog/ifarchive.js';
import { assertAllowed } from '../upstream/allowlist.js';

const IFARCHIVE_HOSTS = ['ifarchive.org', 'www.ifarchive.org'];

export async function ifArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ifarchive/*', async (request, reply) => {
    const path = (request.params as Record<string, string>)['*'] ?? '';
    if (!path) return reply.code(400).send({ error: 'path is required' });

    // Resolve against the archive root, then re-validate: a path containing
    // "../" or a scheme must not be able to escape the host.
    const target = new URL(path.replace(/^\/+/, ''), IFARCHIVE_BASE);
    const parsed = assertAllowed(target.toString(), IFARCHIVE_HOSTS);

    const cache = getCache();
    const entry = await cache.fetch({ url: parsed.toString(), ttl: config.ttl.file });

    return reply
      .header('content-type', entry.contentType)
      .header('content-length', String(entry.size))
      .header('x-cache', entry.fromCache ? 'HIT' : 'MISS')
      .send(cache.stream(entry));
  });
}
