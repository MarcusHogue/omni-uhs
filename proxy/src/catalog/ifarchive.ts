/**
 * IF Archive — the closest analogue to UHS for adventure/interactive fiction.
 *
 * The archive publishes `indexes/Master-Index.xml`, describing every file it
 * holds. That file is ~15 MB, so it is fetched at most once a day and only the
 * hint-bearing subtrees are indexed into SQLite; searching runs locally.
 */

import { config } from '../config.js';
import { log, since } from '../log.js';
import type { Cache } from '../cache/index.js';
import { normalizeTitle } from './normalize.js';
import { escapeLike } from './uhs.js';
import type { CatalogEntry } from './types.js';

const MASTER_INDEX = 'https://ifarchive.org/indexes/Master-Index.xml';
export const IFARCHIVE_BASE = 'https://ifarchive.org/';

/** Directories worth indexing: hints, solutions and InvisiClues. */
const WANTED = [
  'if-archive/solutions',
  'if-archive/infocom/hints',
];

/** Archives and binaries we cannot read; keep the index to readable text. */
const SKIP_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'z', 'sit', 'hqx', 'exe', 'dmg', 'rar', '7z',
  'jpg', 'jpeg', 'png', 'gif', 'pdf', 'mp3', 'wav',
]);

function titleFromPath(name: string): string {
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  return stem
    .replace(/[_+]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMasterIndex(xml: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const fileRe = /<file>([\s\S]*?)<\/file>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(xml)) !== null) {
    const block = match[1]!;
    const directory = /<directory>([\s\S]*?)<\/directory>/.exec(block)?.[1]?.trim() ?? '';
    if (!WANTED.some((prefix) => directory === prefix || directory.startsWith(`${prefix}/`))) {
      continue;
    }
    const path = /<path>([\s\S]*?)<\/path>/.exec(block)?.[1]?.trim() ?? '';
    const name = /<name>([\s\S]*?)<\/name>/.exec(block)?.[1]?.trim() ?? '';
    if (!path || !name) continue;

    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
    if (SKIP_EXTENSIONS.has(extension)) continue;

    const title = titleFromPath(name);
    if (!title) continue;

    const meta: CatalogEntry['meta'] = {};
    const size = Number.parseInt(/<size>(\d+)<\/size>/.exec(block)?.[1] ?? '', 10);
    if (Number.isFinite(size)) meta.size = size;
    const date = /<date>([\s\S]*?)<\/date>/.exec(block)?.[1]?.trim();
    if (date) meta.date = date;

    entries.push({
      sourceKind: 'ifarchive',
      title,
      normalizedTitle: normalizeTitle(title),
      ref: path,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }
  return entries;
}

export async function refreshIfArchiveCatalog(
  cache: Cache,
  options: { force?: boolean } = {},
): Promise<{ entries: number; warnings: string[] }> {
  const state = cache.db
    .prepare('SELECT updated_at, entries FROM catalog_state WHERE source = ?')
    .get('ifarchive') as { updated_at: number; entries: number } | undefined;

  if (
    !options.force &&
    state &&
    Date.now() - state.updated_at < config.ttl.index * 1000 &&
    state.entries > 0
  ) {
    return { entries: state.entries, warnings: [] };
  }

  let entries: CatalogEntry[] = [];
  const warnings: string[] = [];
  const started = performance.now();
  // The master index is ~15 MB. Worth announcing: it is the one thing here that
  // can make a first search feel broken rather than slow.
  log.catalog.info({ source: 'ifarchive' }, 'refreshing the IF Archive master index');
  try {
    const result = await cache.fetch({ url: MASTER_INDEX, ttl: config.ttl.index });
    entries = parseMasterIndex(await cache.readText(result));
  } catch (error) {
    warnings.push(`ifarchive: master index failed (${(error as Error).message})`);
    log.catalog.warn(
      { source: 'ifarchive', kept: state?.entries ?? 0, err: (error as Error).message },
      'IF Archive refresh failed; keeping the existing table',
    );
    return { entries: state?.entries ?? 0, warnings };
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
        'ifarchive',
        entry.ref,
        entry.title,
        entry.normalizedTitle,
        JSON.stringify(entry.meta ?? {}),
        now,
      );
    }
    cache.db
      .prepare(
        `INSERT INTO catalog_state (source, updated_at, entries, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           updated_at = excluded.updated_at, entries = excluded.entries`,
      )
      .run('ifarchive', now, entries.length, 'master-index');
  })();

  log.catalog.info(
    { source: 'ifarchive', entries: entries.length, ms: since(started) },
    `IF Archive index refreshed: ${entries.length} files`,
  );
  return { entries: entries.length, warnings };
}

function rowToEntry(row: Record<string, unknown>): CatalogEntry {
  const meta = row['meta'] ? (JSON.parse(row['meta'] as string) as CatalogEntry['meta']) : undefined;
  return {
    sourceKind: 'ifarchive',
    title: row['title'] as string,
    normalizedTitle: row['normalized_title'] as string,
    ref: row['ref'] as string,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

export function searchIfArchive(cache: Cache, query: string, limit = 25): CatalogEntry[] {
  const normalized = normalizeTitle(query);
  if (normalized === '') return [];
  const rows = cache.db
    .prepare(
      `SELECT ref, title, normalized_title, meta FROM catalog
       WHERE source = 'ifarchive' AND normalized_title LIKE ? ESCAPE '\\'
       ORDER BY length(normalized_title), normalized_title LIMIT ?`,
    )
    .all(`%${escapeLike(normalized)}%`, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function listIfArchive(cache: Cache, prefix: string, limit = 500): CatalogEntry[] {
  const rows = cache.db
    .prepare(
      `SELECT ref, title, normalized_title, meta FROM catalog
       WHERE source = 'ifarchive' AND ref LIKE ? ESCAPE '\\'
       ORDER BY ref LIMIT ?`,
    )
    .all(prefix ? `%${escapeLike(prefix)}%` : '%', limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}
