/**
 * Route-level behaviour, including the graceful-degradation contract: one dead
 * source must produce results plus a warning, never a failed request.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { Cache, setCache } from '../src/cache/index.js';
import { normalizeTitle } from '../src/catalog/normalize.js';
import * as search from '../src/catalog/search.js';

let app: FastifyInstance;
let cache: Cache;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hint-routes-'));
  cache = new Cache(dir);
  setCache(cache);
  app = await buildApp({ logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  cache.close();
  setCache(null);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedCatalog(): void {
  const insert = cache.db.prepare(
    `INSERT INTO catalog (source, ref, title, normalized_title, meta, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'uhs',
    'https://www.uhs-hints.com/rfiles/zork1.zip',
    'Zork I: The Great Underground Empire',
    normalizeTitle('Zork I: The Great Underground Empire'),
    '{}',
    Date.now(),
  );
  cache.db
    .prepare('INSERT INTO catalog_state (source, updated_at, entries, note) VALUES (?, ?, ?, ?)')
    .run('uhs', Date.now(), 1, 'test');
  cache.db
    .prepare('INSERT INTO catalog_state (source, updated_at, entries, note) VALUES (?, ?, ?, ?)')
    .run('ifarchive', Date.now(), 0, 'test');
}

describe('service basics', () => {
  it('answers /healthz', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports its build on /api/version, uncached', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/version' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { version: string; startedAt: string };
    // `dev` unless APP_VERSION was stamped in by the image build.
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(body.startedAt))).toBe(true);
    // A cached version answer is worse than none: it would report the build
    // that was running last time anyone asked.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects anything that is not GET or HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const response = await app.inject({ method, url: '/healthz' });
      expect(response.statusCode).toBe(405);
    }
  });
});

describe('/api/uhs/file', () => {
  it('requires a url', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/uhs/file' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a host outside the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/uhs/file?url=https://example.com/evil.zip',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not allowed/);
  });

  it('rejects an allowlisted host when the path is not a zip', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/uhs/file?url=https://www.uhs-hints.com/cgi-bin/update.cgi',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/zip/);
  });

  it('refuses an SSRF attempt through the url parameter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/uhs/file?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('/api/ifarchive', () => {
  it('cannot be walked out of the archive root', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ifarchive/../../etc/passwd',
    });
    // Either normalised back inside the host (then a normal upstream call) or
    // rejected — what must never happen is reaching a different host.
    expect([400, 404, 502]).toContain(response.statusCode);
  });
});

describe('/api/wiki/:host', () => {
  it('rejects a host that is not in WIKI_ALLOWLIST', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/wiki/evil.example.com?action=query',
    });
    expect(response.statusCode).toBe(400);
  });

  // The allowlist is the only thing standing between "read a wiki" and "read
  // anything", so it guards the metadata route too — not just the fetch.
  it('rejects an off-list host on the site route as well', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/wiki/blue-prince.fandom.com.evil.example.com/site',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().hint).toMatch(/WIKI_ALLOWLIST/);
  });
});

describe('/api/strategywiki', () => {
  it('refuses write actions', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/strategywiki?action=edit' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not proxied/);
  });
});

describe('/api/catalog/search', () => {
  it('requires a query of at least three characters', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalog/search?q=zo' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown source name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/search?q=zork&sources=gamefaqs',
    });
    expect(response.statusCode).toBe(400);
  });

  it('searches the local UHS catalog with no network access', async () => {
    seedCatalog();
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/search?q=zork&sources=uhs',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups[0].title).toBe('Zork I: The Great Underground Empire');
    expect(body.warnings).toEqual([]);
  });

  it('degrades gracefully when a source is down', async () => {
    seedCatalog();
    // ifdb is unreachable; uhs still answers from the local table.
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/search?q=zork&sources=uhs,ifdb',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups.length).toBeGreaterThan(0);
    // The failing source names itself in warnings rather than failing the call.
    if (body.warnings.length > 0) {
      expect(body.warnings.join(' ')).toMatch(/ifdb/);
    }
  });

  it('names every failing source and still returns 200', async () => {
    vi.spyOn(search, 'searchCatalog').mockResolvedValue({
      query: 'zork',
      groups: [],
      warnings: ['strategywiki: timed out after 8000ms', 'ifdb: Upstream responded 403'],
      sources: ['uhs', 'strategywiki', 'ifdb'],
      challenged: [],
    });
    const response = await app.inject({ method: 'GET', url: '/api/catalog/search?q=zork' });
    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toHaveLength(2);
  });

  it('searches the default sources, not every source, when none are named', async () => {
    seedCatalog();
    const response = await app.inject({ method: 'GET', url: '/api/catalog/search?q=zork' });
    expect(response.json().sources).toEqual(['uhs', 'ifarchive', 'ifdb']);
  });
});

describe('/api/catalog/sources', () => {
  it('advertises every searchable source and which are on by default', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalog/sources' });
    expect(response.statusCode).toBe(200);
    const { sources } = response.json() as {
      sources: { kind: string; enabledByDefault: boolean; note?: string }[];
    };
    expect(sources.map((source) => source.kind)).toEqual([
      'uhs',
      'ifarchive',
      'strategywiki',
      'ifdb',
      'fandom',
      'wikigg',
    ]);
    // The wiki platforms are off by default: they do nothing until an operator
    // puts a host in WIKI_ALLOWLIST.
    for (const kind of ['fandom', 'wikigg']) {
      const source = sources.find((s) => s.kind === kind)!;
      expect(source.enabledByDefault).toBe(false);
      expect(source.note).toMatch(/WIKI_ALLOWLIST/);
    }
    const strategywiki = sources.find((source) => source.kind === 'strategywiki')!;
    expect(strategywiki.enabledByDefault).toBe(false);
    expect(strategywiki.note).toMatch(/Cloudflare/);
  });
});

describe('/api/catalog/:source/list', () => {
  it('lists the local UHS catalog', async () => {
    seedCatalog();
    const response = await app.inject({ method: 'GET', url: '/api/catalog/uhs/list' });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toHaveLength(1);
  });

  it('filters by prefix', async () => {
    seedCatalog();
    const response = await app.inject({ method: 'GET', url: '/api/catalog/uhs/list?prefix=myst' });
    expect(response.json().entries).toEqual([]);
  });

  it('refuses a source with no browse listing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalog/gamefaqs/list' });
    expect(response.statusCode).toBe(400);
  });

  // `:source` names a platform of hundreds of wikis, so it cannot say which one.
  it('needs a host to browse a wiki platform', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalog/fandom/list' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/host is required/);
  });

  it('refuses to browse a wiki that is not allowlisted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog/wikigg/list?host=anything.wiki.gg',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().hint).toMatch(/WIKI_ALLOWLIST/);
  });
});
