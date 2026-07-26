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

/** Hosts from WIKI_ALLOWLIST that belong to a given source. */
export function allowlistedHosts(kind: SourceKind): string[] {
  return config.wikiAllowlist.filter((host) => kindForHost(host) === kind);
}

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
`;

let ready = false;
function ensureTable(cache: Cache): void {
  if (ready) return;
  cache.db.exec(SCHEMA);
  ready = true;
}

/** Test seam: forget that the table was created (a new Cache needs it again). */
export function resetWikiRegistry(): void {
  ready = false;
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

const read = (cache: Cache, host: string): WikiSite | null => {
  ensureTable(cache);
  const row = cache.db
    .prepare('SELECT * FROM wiki_site WHERE host = ?')
    .get(host) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    host: row['host'] as string,
    kind: row['kind'] as SourceKind,
    sitename: row['sitename'] as string,
    scriptPath: row['script_path'] as string,
    articlePath: row['article_path'] as string,
    license: row['license'] as string,
    licenseUrl: row['license_url'] as string,
    personalUseOnly: (row['personal_use'] as number) === 1,
    gamepedia: (row['gamepedia'] as number) === 1,
  };
};

/**
 * Look a wiki up, asking it about itself if we have not already.
 *
 * Cached for `ttl.index` (a day): script paths and licences change about never,
 * and a wiki that is down should not make an allowlisted host unusable.
 */
export async function describeWiki(cache: Cache, host: string): Promise<WikiSite> {
  const lower = host.toLowerCase();
  const kind = kindForHost(lower);
  if (!kind) throw new Error(`not a recognised wiki host: ${host}`);

  const cached = read(cache, lower);
  if (cached) return cached;

  const target = bootstrapTarget(lower, kind);
  const url = apiUrl(target.api, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general|rightsinfo',
  });
  const result = await cache.fetch({
    url,
    ttl: config.ttl.index,
    accept: 'application/json',
    allowlist: [lower],
  });
  const raw = await cache.readText(result);
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
