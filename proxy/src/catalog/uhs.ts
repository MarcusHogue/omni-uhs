/**
 * The uhs-hints.com catalog.
 *
 * Primary source is the reader's own catalog endpoint, `/cgi-bin/update.cgi`,
 * which returns every title in one response:
 *
 *   <FILE><FTITLE>Zork I…</FTITLE><FURL>…/rfiles/zork1.zip</FURL>
 *         <FNAME>zork1.uhs</FNAME><FDATE>…</FDATE>
 *         <FSIZE>…</FSIZE><FFULLSIZE>…</FFULLSIZE></FILE>
 *
 * That is one request per day against a site that has been dormant since ~2015,
 * versus ~27 for scraping the per-letter index pages — so the index scrape is
 * kept only as a fallback for the day the endpoint disappears.
 *
 * Search never touches the network: it runs against the SQLite copy.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { normalizeTitle } from './normalize.js';
import type { CatalogEntry } from './types.js';

const CATALOG_URL = 'https://www.uhs-hints.com/cgi-bin/update.cgi';
const INDEX_URL = 'https://www.uhs-hints.com/hints/allhints.php';

export interface UhsCatalogEntry extends CatalogEntry {
  sourceKind: 'uhs';
  /** The .uhs filename inside the zip. */
  fileName: string;
}

/** Parse the `<FILE>` records returned by update.cgi. */
export function parseUpdateCgi(body: string): UhsCatalogEntry[] {
  const entries: UhsCatalogEntry[] = [];
  const fileRe = /<FILE>([\s\S]*?)<\/FILE>/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(body)) !== null) {
    const block = match[1]!;
    const field = (tag: string): string => {
      const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
      return found?.[1]?.trim() ?? '';
    };
    const title = field('FTITLE');
    const url = field('FURL');
    if (!title || !url) continue;

    // The catalog still advertises http:// URLs; the site serves https fine.
    const ref = url.replace(/^http:\/\//i, 'https://');
    const meta: UhsCatalogEntry['meta'] = {};
    const size = Number.parseInt(field('FSIZE'), 10);
    if (Number.isFinite(size)) meta.size = size;
    const date = field('FDATE');
    if (date) meta.date = date;

    entries.push({
      sourceKind: 'uhs',
      title,
      normalizedTitle: normalizeTitle(title),
      ref,
      fileName: field('FNAME'),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }
  return entries;
}

/**
 * Fallback: scrape the public index page.
 *
 * Only used when update.cgi fails. Deliberately forgiving about markup — it
 * looks for links to /rfiles/*.zip and takes the link text as the title.
 */
export function parseIndexHtml(html: string): UhsCatalogEntry[] {
  const entries = new Map<string, UhsCatalogEntry>();
  const linkRe = /<a[^>]+href=["']([^"']*rfiles\/([^"'/]+)\.zip)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1]!;
    const stem = match[2]!;
    const title = match[3]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const ref = new URL(href, 'https://www.uhs-hints.com/hints/').toString();
    entries.set(ref, {
      sourceKind: 'uhs',
      title,
      normalizedTitle: normalizeTitle(title),
      ref,
      fileName: `${stem}.uhs`,
    });
  }
  return [...entries.values()];
}

export interface RefreshResult {
  entries: number;
  source: 'update.cgi' | 'index-scrape';
  warnings: string[];
}

/**
 * Refresh the local catalog table if it is older than the TTL.
 *
 * Returns without touching the network when the copy is fresh — this is the
 * "never bulk-crawl" guarantee from spec §11.
 */
export async function refreshUhsCatalog(
  cache: Cache,
  options: { force?: boolean } = {},
): Promise<RefreshResult> {
  const state = cache.db
    .prepare('SELECT updated_at, entries FROM catalog_state WHERE source = ?')
    .get('uhs') as { updated_at: number; entries: number } | undefined;

  const age = state ? Date.now() - state.updated_at : Infinity;
  if (!options.force && state && age < config.ttl.catalog * 1000 && state.entries > 0) {
    return { entries: state.entries, source: 'update.cgi', warnings: [] };
  }

  const warnings: string[] = [];
  let entries: UhsCatalogEntry[] = [];
  let usedSource: RefreshResult['source'] = 'update.cgi';

  try {
    const result = await cache.fetch({
      url: CATALOG_URL,
      ttl: config.ttl.catalog,
      accept: 'application/x-uhs-catalog, text/html;q=0.5',
    });
    entries = parseUpdateCgi(await cache.readText(result));
    if (entries.length === 0) warnings.push('uhs: catalog endpoint returned no entries');
  } catch (error) {
    warnings.push(`uhs: catalog endpoint failed (${(error as Error).message})`);
  }

  if (entries.length === 0) {
    try {
      const result = await cache.fetch({ url: INDEX_URL, ttl: config.ttl.catalog });
      entries = parseIndexHtml(await cache.readText(result));
      usedSource = 'index-scrape';
    } catch (error) {
      warnings.push(`uhs: index scrape failed (${(error as Error).message})`);
    }
  }

  if (entries.length === 0) {
    // Keep whatever we already have rather than emptying the table.
    return { entries: state?.entries ?? 0, source: usedSource, warnings };
  }

  const insert = cache.db.prepare(
    `INSERT INTO catalog (source, ref, title, normalized_title, meta, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, ref) DO UPDATE SET
       title = excluded.title, normalized_title = excluded.normalized_title,
       meta = excluded.meta, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  cache.db.transaction(() => {
    for (const entry of entries) {
      insert.run(
        'uhs',
        entry.ref,
        entry.title,
        entry.normalizedTitle,
        JSON.stringify({ ...entry.meta, fileName: entry.fileName }),
        now,
      );
    }
    cache.db
      .prepare(
        `INSERT INTO catalog_state (source, updated_at, entries, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           updated_at = excluded.updated_at, entries = excluded.entries, note = excluded.note`,
      )
      .run('uhs', now, entries.length, usedSource);
  })();

  return { entries: entries.length, source: usedSource, warnings };
}

/** LIKE wildcards in user input must match literally, not as patterns. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function rowToEntry(row: Record<string, unknown>): CatalogEntry {
  const meta = row['meta'] ? (JSON.parse(row['meta'] as string) as Record<string, unknown>) : {};
  const entry: CatalogEntry = {
    sourceKind: 'uhs',
    title: row['title'] as string,
    normalizedTitle: row['normalized_title'] as string,
    ref: row['ref'] as string,
  };
  const cleaned: Record<string, unknown> = {};
  for (const key of ['year', 'platform', 'complete', 'size', 'date'] as const) {
    if (meta[key] !== undefined) cleaned[key] = meta[key];
  }
  if (Object.keys(cleaned).length > 0) entry.meta = cleaned as CatalogEntry['meta'];
  return entry;
}

/** Substring search over the locally stored catalog. Never hits the network. */
export function searchUhsCatalog(cache: Cache, query: string, limit = 50): CatalogEntry[] {
  const normalized = normalizeTitle(query);
  // An empty needle would LIKE-match the entire catalog.
  if (normalized === '') return [];
  const rows = cache.db
    .prepare(
      `SELECT ref, title, normalized_title, meta FROM catalog
       WHERE source = 'uhs' AND normalized_title LIKE ? ESCAPE '\\'
       ORDER BY normalized_title LIMIT ?`,
    )
    .all(`%${escapeLike(normalized)}%`, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** A–Z browse listing. */
export function listUhsCatalog(cache: Cache, prefix: string, limit = 500): CatalogEntry[] {
  const rows = prefix
    ? (cache.db
        .prepare(
          `SELECT ref, title, normalized_title, meta FROM catalog
           WHERE source = 'uhs' AND normalized_title LIKE ? ESCAPE '\\'
           ORDER BY normalized_title LIMIT ?`,
        )
        .all(`${escapeLike(normalizeTitle(prefix))}%`, limit) as Record<string, unknown>[])
    : (cache.db
        .prepare(
          `SELECT ref, title, normalized_title, meta FROM catalog
           WHERE source = 'uhs' ORDER BY normalized_title LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToEntry);
}
