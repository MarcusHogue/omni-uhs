/**
 * Fastify application factory. Kept separate from `server.ts` so tests can
 * build an app without binding a port.
 */

import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { getCache } from './cache/index.js';
import { config } from './config.js';
import { log, logger } from './log.js';
import { checkRelease } from './release.js';
import { UpstreamRejected } from './upstream/allowlist.js';
import { catalogRoutes } from './routes/catalog.js';
import { ifArchiveRoutes } from './routes/ifarchive.js';
import { uhsRoutes } from './routes/uhs.js';
import { wikiRoutes } from './routes/wiki.js';

export interface AppOptions {
  logger?: boolean;
}

/** Reported by /api/version so a restart is visible without reading the logs. */
const STARTED_AT = new Date().toISOString();

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

  /**
   * GET/HEAD only, and no request body is ever forwarded upstream (spec §8).
   *
   * The one exception is the wiki allowlist, which is *local* state: adding a
   * wiki writes a row in this server's own database and sends nothing anywhere.
   * The rule it must not break is that a client cannot make this server write
   * to somebody else's site, and it does not.
   *
   * A state-changing GET would have been the worse trade: any page the user
   * visits can issue one with an `<img>` tag, and no browser protection
   * applies. Two rules keep that door shut instead:
   *
   * 1. Writes are POST or DELETE, on one path.
   * 2. A POST must be `application/json`.
   *
   * Together those make every cross-origin attempt a *non-simple* request, so
   * the browser must preflight it — and this server answers no OPTIONS and
   * sends no `Access-Control-Allow-Origin`, so the preflight fails and the real
   * request is never sent. A form POST, the one shape that dodges preflight,
   * cannot carry a JSON content type and is refused here.
   *
   * Comparing `Origin` against `Host` was the obvious alternative and is the
   * wrong check: any reverse proxy that rewrites Host — which is most of them,
   * configurably — turns "add a wiki" into an unexplained 403.
   */
  const WRITABLE = /^\/api\/wiki\/allow(\/|$)/;

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;

    const path = request.url.split('?')[0] ?? '';
    const writable =
      WRITABLE.test(path) && (request.method === 'POST' || request.method === 'DELETE');
    if (!writable) {
      return reply.code(405).header('allow', 'GET, HEAD').send({ error: 'method not allowed' });
    }

    if (request.method === 'POST') {
      const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') {
        return reply
          .code(415)
          .send({ error: 'writes must be application/json' });
      }
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

  app.get('/healthz', async () => ({ status: 'ok', version: config.version }));

  /**
   * Which build is answering.
   *
   * The web app compares this with the version baked into its own bundle: a
   * mismatch means one of the two containers was updated and the other was not,
   * or the browser is still running a cached bundle from before the last
   * deploy. Never cached — a stale answer here is worse than none.
   */
  app.get('/api/version', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      version: config.version,
      startedAt: STARTED_AT,
    }),
  );

  /**
   * Whether a newer image has been published.
   *
   * Lazy rather than polled: the answer is cached for six hours, so asking on
   * every app launch costs nothing, and a container nobody opens makes no
   * requests at all.
   */
  app.get('/api/release', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await checkRelease(getCache())),
  );

  await app.register(uhsRoutes);
  await app.register(ifArchiveRoutes);
  await app.register(wikiRoutes);
  await app.register(catalogRoutes);

  return app;
}
