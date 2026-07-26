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
import { normalizeTitle } from '../catalog/normalize.js';
import { allowlistedHosts, describeWiki, gameTitleOf } from '../catalog/wikis.js';
import {
  DEFAULT_SEARCH_SOURCES,
  SEARCHABLE_SOURCES,
  describeSources,
  searchCatalog,
} from '../catalog/search.js';
import type { CatalogEntry, SourceKind } from '../catalog/types.js';
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
        // One row per wiki, because a wiki is a game. Paging through a game
        // wiki's thousands of pages was never the useful view: the pages are
        // sections of one title, and the download gathers them.
        const warnings: string[] = [];
        const entries: CatalogEntry[] = [];
        for (const host of allowlistedHosts(cache, source)) {
          try {
            const site = await describeWiki(cache, host);
            const title = gameTitleOf(site.sitename, host);
            if (prefix && !title.toLowerCase().startsWith(prefix.toLowerCase())) continue;
            entries.push({
              sourceKind: source,
              title,
              normalizedTitle: normalizeTitle(title),
              ref: host,
              host,
              // Shown before the download, because a -NC wiki marks everything
              // it yields personal-use-only and that is worth knowing first.
              meta: { license: site.license, personalUseOnly: site.personalUseOnly },
            });
          } catch (error) {
            warnings.push(`${host}: ${(error as Error).message}`);
          }
        }
        return reply.send({ source, entries, warnings });
      }
      default:
        return reply.code(400).send({ error: `no browse listing for source: ${source}` });
    }
  });
}
