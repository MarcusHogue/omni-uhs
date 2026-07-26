/**
 * Unified catalog routes (spec §7.2a).
 *
 *   GET /api/catalog/search?q=&sources=   fan-out, merged and grouped
 *   GET /api/catalog/:source/list?prefix= per-source browse listing
 */

import type { FastifyInstance } from 'fastify';

import { getCache } from '../cache/index.js';
import { listIfArchive, refreshIfArchiveCatalog } from '../catalog/ifarchive.js';
import { STRATEGYWIKI, listWikiPages } from '../catalog/mediawiki.js';
import { isWikiAllowed, targetFor } from '../catalog/wikis.js';
import {
  DEFAULT_SEARCH_SOURCES,
  SEARCHABLE_SOURCES,
  describeSources,
  searchCatalog,
} from '../catalog/search.js';
import type { SourceKind } from '../catalog/types.js';
import { listUhsCatalog, refreshUhsCatalog } from '../catalog/uhs.js';

const MIN_QUERY = 3;

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // Which sources exist, and which the server searches when asked for none.
  // The UI reads this rather than hard-coding the list, so SEARCH_SOURCES on
  // the server is what actually decides the default chips.
  app.get('/api/catalog/sources', async (_request, reply) =>
    reply.send({ sources: describeSources(getCache()) }),
  );

  app.get('/api/catalog/search', async (request, reply) => {
    const { q, sources } = request.query as { q?: string; sources?: string };
    const query = (q ?? '').trim();
    if (query.length < MIN_QUERY) {
      return reply.code(400).send({ error: `q must be at least ${MIN_QUERY} characters` });
    }

    // No `sources` means "whatever the server considers useful by default",
    // which is not the same as "everything" — see DEFAULT_SEARCH_SOURCES.
    const requested = sources
      ? (sources.split(',').map((s) => s.trim()).filter(Boolean) as SourceKind[])
      : DEFAULT_SEARCH_SOURCES;
    const unknown = requested.filter((s) => !SEARCHABLE_SOURCES.includes(s));
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `unknown source(s): ${unknown.join(', ')}` });
    }

    const result = await searchCatalog(getCache(), query, requested);
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/catalog/:source/list', async (request, reply) => {
    const { source } = request.params as { source: string };
    const { prefix } = request.query as { prefix?: string };
    const cache = getCache();

    switch (source) {
      case 'uhs': {
        const state = await refreshUhsCatalog(cache);
        return reply.send({
          source,
          entries: listUhsCatalog(cache, prefix ?? ''),
          warnings: state.warnings,
        });
      }
      case 'ifarchive': {
        const state = await refreshIfArchiveCatalog(cache);
        return reply.send({
          source,
          entries: listIfArchive(cache, prefix ?? ''),
          warnings: state.warnings,
        });
      }
      case 'strategywiki': {
        if (!prefix) {
          return reply
            .code(400)
            .send({ error: 'prefix is required for strategywiki (e.g. "Chrono Trigger/")' });
        }
        try {
          return reply.send({
            source,
            entries: await listWikiPages(cache, STRATEGYWIKI, prefix),
            warnings: [],
          });
        } catch (error) {
          return reply.send({
            source,
            entries: [],
            warnings: [`${source}: ${(error as Error).message}`],
            // The browser may reach a host that bot-challenged this server.
            challenged: (error as { upstreamChallenge?: boolean }).upstreamChallenge
              ? [source]
              : [],
          });
        }
      }
      case 'fandom':
      case 'wikigg': {
        // Which wiki has to come from a query parameter: `:source` names the
        // platform, and a platform is hundreds of independent wikis.
        const { host } = request.query as { host?: string };
        if (!host) {
          return reply
            .code(400)
            .send({ error: `host is required for ${source} (e.g. ?host=animalwell.wiki.gg)` });
        }
        if (!isWikiAllowed(cache, host)) {
          return reply.code(400).send({
            error: `wiki host not allowed: ${host}`,
            hint: 'add it in Settings, or to WIKI_ALLOWLIST',
          });
        }
        try {
          const target = await targetFor(cache, host.toLowerCase());
          return reply.send({
            source,
            entries: await listWikiPages(cache, target, prefix ?? ''),
            warnings: [],
          });
        } catch (error) {
          return reply.send({
            source,
            entries: [],
            warnings: [`${host}: ${(error as Error).message}`],
          });
        }
      }
      default:
        return reply.code(400).send({ error: `no browse listing for source: ${source}` });
    }
  });
}
