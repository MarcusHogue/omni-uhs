/**
 * The wiki registry: everything we know about an allowlisted MediaWiki host.
 *
 * Fandom and wiki.gg are not two sources so much as two *platforms* hosting
 * hundreds of independent wikis, and the differences between them are not
 * guessable:
 *
 * - Both serve `api.php` at the site root, not `/w/`. The old rule here —
 *   "Fandom is `/api.php`, everyone else is `/w/api.php`" — makes every wiki.gg
 *   request a 404, verified against `terraria.wiki.gg`.
 * - A Fandom language wiki (`elderscrolls.fandom.com/de/`) is a *different*
 *   wiki with a different script path, so the path cannot be derived from the
 *   hostname either.
 * - Licences vary per wiki, not per platform. Plenty of game wikis on both are
 *   CC-BY-NC-SA, which has to force `personalUseOnly`.
 *
 * So we ask. One `siteinfo` call per host on first contact tells us the script
 * path, the article path and the licence; the answer is cached in SQLite and
 * everything else is built from it.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { log } from '../log.js';
import { apiUrl, parseRightsInfo, type WikiTarget } from './mediawiki.js';
import type { SourceKind } from './types.js';

export interface WikiSite {
  host: string;
  kind: SourceKind;
  /** The wiki's own name, e.g. "Blue Prince Wiki". */
  sitename: string;
  /** MediaWiki `scriptpath` — "" on both Fandom and wiki.gg, "/w" elsewhere. */
  scriptPath: string;
  /** MediaWiki `articlepath`, e.g. "/wiki/$1". */
  articlePath: string;
  license: string;
  licenseUrl: string;
  personalUseOnly: boolean;
  /**
   * Fandom's ex-Gamepedia flag. A positive-only hint that a wiki is about a
   * game — plenty of game wikis predate Gamepedia and report false — and the
   * only games signal Fandom exposes at all, now that the vertical/hub API is
   * gone. Recorded for the discovery UI to show; never used to gate anything.
   */
  gamepedia: boolean;
}

/** Which source a host belongs to. */
export function kindForHost(host: string): SourceKind | null {
  const lower = host.toLowerCase();
  if (lower === 'strategywiki.org' || lower === 'www.strategywiki.org') return 'strategywiki';
  if (lower.endsWith('.fandom.com')) return 'fandom';
  if (lower.endsWith('.wiki.gg')) return 'wikigg';
  return null;
}

/** The platforms a wiki can be added from at runtime. */
export const WIKI_PLATFORMS: SourceKind[] = ['fandom', 'wikigg'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_site (
  host             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  sitename         TEXT NOT NULL,
  script_path      TEXT NOT NULL,
  article_path     TEXT NOT NULL,
  license          TEXT NOT NULL,
  license_url      TEXT NOT NULL,
  personal_use     INTEGER NOT NULL,
  gamepedia        INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_allow (
  host             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  added_at         INTEGER NOT NULL
);
`;

/**
 * Which caches have had the tables created.
 *
 * Per instance, not a module-level boolean: `setCache` can swap the cache out —
 * every test does, and a restart with a fresh cache file would too — and a
 * global flag would then skip `CREATE TABLE` on a database that has none,
 * turning every wiki lookup into a SQL error.
 */
const prepared = new WeakSet<Cache>();

function ensureTable(cache: Cache): void {
  if (prepared.has(cache)) return;
  cache.db.exec(SCHEMA);
  prepared.add(cache);
}

/* -------------------------------------------------------------- allowlist */

/**
 * Which wikis this deployment may read.
 *
 * Two sources, deliberately:
 *
 * - **`WIKI_ALLOWLIST`** is the operator's standing decision. It seeds a fresh
 *   container and cannot be revoked from the app — if it is in the environment,
 *   somebody meant it.
 * - **The `wiki_allow` table** is what you add from the UI. It survives
 *   restarts, takes effect immediately, and can be removed again.
 *
 * Adding is bounded by `kindForHost`: only `*.fandom.com` and `*.wiki.gg` are
 * ever accepted, so nothing reachable from the app can point the fetcher at an
 * internal address. Every other host still has to be listed in
 * `UPSTREAM_ALLOWLIST` and matched exactly.
 */
const envAllowlist = (): string[] =>
  config.wikiAllowlist.map((host) => host.toLowerCase()).filter((host) => kindForHost(host));

/** True for a host named in the environment, which the app must not remove. */
export function isPinned(host: string): boolean {
  return envAllowlist().includes(host.toLowerCase());
}

function storedAllowlist(cache: Cache): { host: string; kind: SourceKind }[] {
  ensureTable(cache);
  return cache.db.prepare('SELECT host, kind FROM wiki_allow ORDER BY host').all() as {
    host: string;
    kind: SourceKind;
  }[];
}

/** Every allowlisted wiki host, from both sources. */
export function allowedWikiHosts(cache: Cache): string[] {
  const hosts = new Set(envAllowlist());
  for (const row of storedAllowlist(cache)) hosts.add(row.host);
  return [...hosts].sort();
}

export function isWikiAllowed(cache: Cache, host: string): boolean {
  return allowedWikiHosts(cache).includes(host.toLowerCase());
}

/** Allowlisted hosts belonging to one platform. */
export function allowlistedHosts(cache: Cache, kind: SourceKind): string[] {
  return allowedWikiHosts(cache).filter((host) => kindForHost(host) === kind);
}

/**
 * Add a wiki, after confirming it is one.
 *
 * The `describeWiki` call is not a formality: it is what proves the host is a
 * real MediaWiki rather than a parked domain, and it is where the licence comes
 * from. Nothing is allowlisted on the strength of its name alone.
 */
export async function allowWiki(cache: Cache, host: string): Promise<WikiSite> {
  const lower = host.toLowerCase().replace(/\.$/, '');
  const kind = kindForHost(lower);
  if (!kind || !WIKI_PLATFORMS.includes(kind)) {
    throw Object.assign(
      new Error(`only Fandom and wiki.gg wikis can be added here: ${host}`),
      { statusCode: 400 },
    );
  }

  const site = await describeWiki(cache, lower);
  ensureTable(cache);
  cache.db
    .prepare(
      `INSERT INTO wiki_allow (host, kind, added_at) VALUES (?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET kind = excluded.kind`,
    )
    .run(lower, kind, Date.now());
  log.catalog.info(
    { host: lower, kind, license: site.license, personalUseOnly: site.personalUseOnly },
    `allowlisted ${lower} (${site.license})`,
  );
  return site;
}

/** Remove a wiki. Returns false for one pinned by the environment. */
export function forgetWiki(cache: Cache, host: string): boolean {
  const lower = host.toLowerCase();
  if (isPinned(lower)) return false;
  ensureTable(cache);
  cache.db.prepare('DELETE FROM wiki_allow WHERE host = ?').run(lower);
  log.catalog.info({ host: lower }, `removed ${lower} from the wiki allowlist`);
  return true;
}

interface SiteinfoPayload {
  query?: {
    general?: {
      sitename?: string;
      scriptpath?: string;
      articlepath?: string;
      gamepedia?: string | boolean;
    };
    rightsinfo?: { text?: string; url?: string };
  };
}

/**
 * A target good enough to make the one bootstrap call.
 *
 * Both platforms serve `api.php` at the root, so that is the guess; if a wiki
 * disagrees, `siteinfo` tells us and `targetFor` rebuilds from the real path.
 */
const bootstrapTarget = (host: string, kind: SourceKind): WikiTarget => ({
  kind,
  api: `https://${host}/api.php`,
  pageBase: `https://${host}/wiki/`,
  allowlist: [host],
});

const read = (cache: Cache, host: string): { site: WikiSite; age: number } | null => {
  ensureTable(cache);
  const row = cache.db
    .prepare('SELECT * FROM wiki_site WHERE host = ?')
    .get(host) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    age: Date.now() - (row['updated_at'] as number),
    site: {
      host: row['host'] as string,
      kind: row['kind'] as SourceKind,
      sitename: row['sitename'] as string,
      scriptPath: row['script_path'] as string,
      articlePath: row['article_path'] as string,
      license: row['license'] as string,
      licenseUrl: row['license_url'] as string,
      personalUseOnly: (row['personal_use'] as number) === 1,
      gamepedia: (row['gamepedia'] as number) === 1,
    },
  };
};

/**
 * Look a wiki up, asking it about itself if what we have has gone stale.
 *
 * Fresh for `ttl.index` (a day). It has to expire: a licence is not decoration
 * here, it decides whether documents from this wiki can leave the device, and a
 * wiki that relicenses to `-NC` would otherwise keep producing shareable
 * exports forever. Script and article paths move too, if rarely.
 *
 * A stale row still beats nothing, so a failed refresh serves the old answer
 * rather than making an allowlisted host unusable while its wiki is down.
 */
export async function describeWiki(cache: Cache, host: string): Promise<WikiSite> {
  const lower = host.toLowerCase();
  const kind = kindForHost(lower);
  if (!kind) throw new Error(`not a recognised wiki host: ${host}`);

  const cached = read(cache, lower);
  if (cached && cached.age < config.ttl.index * 1000) return cached.site;

  const target = bootstrapTarget(lower, kind);
  const url = apiUrl(target.api, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general|rightsinfo',
  });
  let raw: string;
  try {
    const result = await cache.fetch({
      url,
      ttl: config.ttl.index,
      accept: 'application/json',
      allowlist: [lower],
    });
    raw = await cache.readText(result);
  } catch (error) {
    if (!cached) throw error;
    log.catalog.warn(
      { host: lower, err: (error as Error).message },
      `could not refresh ${lower}; using what was recorded ${Math.round(
        cached.age / 3_600_000,
      )}h ago`,
    );
    return cached.site;
  }
  const payload = JSON.parse(raw) as SiteinfoPayload;
  const general = payload.query?.general ?? {};
  const rights = parseRightsInfo(raw);

  const site: WikiSite = {
    host: lower,
    kind,
    sitename: general.sitename ?? lower,
    scriptPath: general.scriptpath ?? '',
    articlePath: general.articlepath ?? '/wiki/$1',
    license: rights.license,
    licenseUrl: rights.url,
    personalUseOnly: rights.personalUseOnly,
    // Fandom reports the string 'true'/'false', not a boolean.
    gamepedia: general.gamepedia === true || general.gamepedia === 'true',
  };

  ensureTable(cache);
  cache.db
    .prepare(
      `INSERT INTO wiki_site
         (host, kind, sitename, script_path, article_path, license, license_url,
          personal_use, gamepedia, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
         kind = excluded.kind, sitename = excluded.sitename,
         script_path = excluded.script_path, article_path = excluded.article_path,
         license = excluded.license, license_url = excluded.license_url,
         personal_use = excluded.personal_use, gamepedia = excluded.gamepedia,
         updated_at = excluded.updated_at`,
    )
    .run(
      site.host,
      site.kind,
      site.sitename,
      site.scriptPath,
      site.articlePath,
      site.license,
      site.licenseUrl,
      site.personalUseOnly ? 1 : 0,
      site.gamepedia ? 1 : 0,
      Date.now(),
    );

  log.catalog.info(
    {
      host: site.host,
      kind: site.kind,
      sitename: site.sitename,
      license: site.license,
      personalUseOnly: site.personalUseOnly,
    },
    `registered wiki ${site.host} (${site.license})`,
  );
  return site;
}

/** The `WikiTarget` for an allowlisted host, built from what it told us. */
export async function targetFor(cache: Cache, host: string): Promise<WikiTarget> {
  const site = await describeWiki(cache, host);
  return siteTarget(site);
}

/** Pure form, for tests and for callers that already hold a `WikiSite`. */
export function siteTarget(site: WikiSite): WikiTarget {
  return {
    kind: site.kind,
    api: `https://${site.host}${site.scriptPath}/api.php`,
    // `articlepath` is "/wiki/$1"; the prefix is everything before the $1.
    pageBase: `https://${site.host}${site.articlePath.replace('$1', '')}`,
    allowlist: [site.host],
  };
}
