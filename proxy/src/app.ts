/**
 * Fastify application factory. Kept separate from `server.ts` so tests can
 * build an app without binding a port.
 */

import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { config } from './config.js';
import { log, logger } from './log.js';
import { UpstreamRejected } from './upstream/allowlist.js';
import { catalogRoutes } from './routes/catalog.js';
import { ifArchiveRoutes } from './routes/ifarchive.js';
import { uhsRoutes } from './routes/uhs.js';
import { wikiRoutes } from './routes/wiki.js';

export interface AppOptions {
  logger?: boolean;
}

/** The health check fires every 30 seconds and is never worth a log line. */
const isNoise = (url: string): boolean => url === '/healthz' || url.startsWith('/healthz?');

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // The cast keeps Fastify's default generics: handing it a concrete pino
    // Logger otherwise specialises FastifyInstance and every route type with it.
    ...(options.logger === false
      ? { logger: false }
      : { loggerInstance: logger as FastifyBaseLogger }),
    // Fastify's own request logging is two lines and a nested object per
    // request. One line with the fields you would actually grep for is more
    // useful in `docker logs`, so it is replaced by the hook below.
    logController: new LogController({ disableRequestLogging: true }),
    // Hint files are the only large payloads and they stream; nothing is posted.
    bodyLimit: 1024,
    trustProxy: true,
  });

  /**
   * Access log: one line per request, after the response is sent.
   *
   * `x-cache` is included because it is the single most useful field here —
   * it distinguishes "slow because the upstream is slow" from "slow for some
   * other reason", without having to correlate with the upstream log.
   */
  if (options.logger !== false && config.logRequests) {
    app.addHook('onResponse', async (request, reply) => {
      if (isNoise(request.url)) return;
      log.http.info(
        {
          method: request.method,
          url: request.url,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          cache: reply.getHeader('x-cache') ?? undefined,
          ip: request.ip,
        },
        `${request.method} ${request.url} ${reply.statusCode}`,
      );
    });
  }

  /** GET/HEAD only, and no request bodies are ever forwarded (spec §8). */
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'method not allowed' });
    }
  });

  app.setErrorHandler(
    (error: Error & { statusCode?: number; upstreamChallenge?: boolean }, request, reply) => {
      const status =
        error instanceof UpstreamRejected ? error.statusCode : (error.statusCode ?? 500);
      if (status >= 500) request.log.error({ err: error }, 'request failed');
      else request.log.warn({ err: error.message, url: request.url }, 'request rejected');
      return reply.code(status).send({
        error: error.message,
        ...(error.upstreamChallenge ? { code: 'upstream_challenge' } : {}),
      });
    },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(uhsRoutes);
  await app.register(ifArchiveRoutes);
  await app.register(wikiRoutes);
  await app.register(catalogRoutes);

  return app;
}
