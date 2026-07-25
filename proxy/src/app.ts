/**
 * Fastify application factory. Kept separate from `server.ts` so tests can
 * build an app without binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { UpstreamRejected } from './upstream/allowlist.js';
import { catalogRoutes } from './routes/catalog.js';
import { ifArchiveRoutes } from './routes/ifarchive.js';
import { uhsRoutes } from './routes/uhs.js';
import { wikiRoutes } from './routes/wiki.js';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    // Hint files are the only large payloads and they stream; nothing is posted.
    bodyLimit: 1024,
    trustProxy: true,
  });

  /** GET/HEAD only, and no request bodies are ever forwarded (spec §8). */
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'method not allowed' });
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status =
      error instanceof UpstreamRejected ? error.statusCode : (error.statusCode ?? 500);
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.warn({ err: error.message, url: request.url }, 'request rejected');
    return reply.code(status).send({ error: error.message });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(uhsRoutes);
  await app.register(ifArchiveRoutes);
  await app.register(wikiRoutes);
  await app.register(catalogRoutes);

  return app;
}
