/**
 * One logger for the whole service.
 *
 * Fastify brings pino, so the request log and everything the cache, upstream
 * and catalog modules have to say share a stream and a format. That matters for
 * `docker logs`: correlating "the search was slow" with "the IF Archive index
 * was being refetched" only works if both lines are in the same place.
 *
 * Output is newline-delimited JSON, which is what every log shipper and
 * `docker logs --since` expects. It is dense to read by eye, so pipe it through
 * `jq` when you are debugging by hand — `docs/SETUP.md` has the recipes.
 */

import pino, { type Logger } from 'pino';

import { config } from './config.js';

export const logger: Logger = pino({
  level: config.logLevel,
  base: undefined, // pid/hostname are noise inside a container
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Child loggers, so every line says which part of the service produced it.
 * `docker logs omni-uhs-proxy | jq 'select(.component=="upstream")'`.
 */
export const log = {
  http: logger.child({ component: 'http' }),
  cache: logger.child({ component: 'cache' }),
  upstream: logger.child({ component: 'upstream' }),
  catalog: logger.child({ component: 'catalog' }),
  search: logger.child({ component: 'search' }),
};

/** Milliseconds, rounded — nobody needs nanoseconds in an access log. */
export const since = (start: number): number => Math.round(performance.now() - start);
