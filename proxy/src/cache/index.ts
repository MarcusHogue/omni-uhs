/**
 * Content-addressed blob store with a SQLite index.
 *
 * Blobs are files named after the SHA-256 of their contents; the SQLite table
 * maps a cache key (usually the upstream URL) to a blob plus the validators
 * needed for a conditional revalidation. Responses stream straight to disk, so
 * a 5 MB hint file never lands in memory.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import Database from 'better-sqlite3';

import { config } from '../config.js';
import { SingleFlight } from '../upstream/limiter.js';
import { fetchUpstream, type UpstreamRequest } from '../upstream/fetch.js';

export interface CacheEntry {
  key: string;
  blobPath: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  ttl: number;
  size: number;
}

export interface CachedResult extends CacheEntry {
  /** Whether this call went to the network. */
  revalidated: boolean;
  fromCache: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  key           TEXT PRIMARY KEY,
  blob          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  fetched_at    INTEGER NOT NULL,
  ttl           INTEGER NOT NULL,
  size          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog (
  source           TEXT NOT NULL,
  ref              TEXT NOT NULL,
  title            TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  meta             TEXT,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (source, ref)
);
CREATE INDEX IF NOT EXISTS catalog_normalized ON catalog (normalized_title);
CREATE TABLE IF NOT EXISTS catalog_state (
  source     TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  entries    INTEGER NOT NULL,
  note       TEXT
);
`;

/**
 * Turn an unwritable cache directory into an instruction.
 *
 * The container runs as the distroless `nonroot` user (uid 65532). The image
 * ships `/data/cache` already owned by that user, so a *named volume* inherits
 * the right ownership automatically — but a *bind mount* replaces the directory
 * wholesale, keeping whatever the host created, which is usually root. The bare
 * `EACCES … mkdir` this produces says nothing about how to fix it, and a NAS is
 * exactly where people use bind mounts.
 */
export function describeCacheDirFailure(dir: string, error: NodeJS.ErrnoException): Error {
  if (error.code !== 'EACCES' && error.code !== 'EPERM') return error;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'the container user';
  return new Error(
    `Cannot write to CACHE_DIR (${dir}): ${error.code}.\n` +
      `\n` +
      `This container runs as uid ${uid}. If ${dir} is a bind mount from the host,\n` +
      `give that user ownership of the host directory:\n` +
      `\n` +
      `    sudo chown -R 65532:65532 /path/on/host\n` +
      `\n` +
      `A named Docker volume needs no such step — the image seeds the ownership.`,
  );
}

export class Cache {
  readonly db: Database.Database;
  private readonly blobDir: string;
  private readonly flight = new SingleFlight();
  /** Test hook: counts actual upstream fetches. */
  upstreamFetches = 0;

  constructor(dir: string = config.cacheDir) {
    this.blobDir = join(dir, 'blobs');
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(this.blobDir, { recursive: true });
    } catch (error) {
      throw describeCacheDirFailure(dir, error as NodeJS.ErrnoException);
    }
    this.db = new Database(join(dir, 'index.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private read(key: string): CacheEntry | null {
    const row = this.db
      .prepare(
        'SELECT key, blob, content_type, etag, last_modified, fetched_at, ttl, size FROM cache WHERE key = ?',
      )
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entry: CacheEntry = {
      key: row['key'] as string,
      blobPath: join(this.blobDir, row['blob'] as string),
      contentType: row['content_type'] as string,
      etag: (row['etag'] as string | null) ?? null,
      lastModified: (row['last_modified'] as string | null) ?? null,
      fetchedAt: row['fetched_at'] as number,
      ttl: row['ttl'] as number,
      size: row['size'] as number,
    };
    try {
      statSync(entry.blobPath);
    } catch {
      // Blob vanished (manual cleanup, restored backup): treat as a miss.
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return null;
    }
    return entry;
  }

  private isFresh(entry: CacheEntry, now = Date.now()): boolean {
    return now - entry.fetchedAt < entry.ttl * 1000;
  }

  private write(
    key: string,
    blob: string,
    contentType: string,
    etag: string | null,
    lastModified: string | null,
    ttl: number,
    size: number,
  ): CacheEntry {
    const fetchedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO cache (key, blob, content_type, etag, last_modified, fetched_at, ttl, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           blob = excluded.blob, content_type = excluded.content_type,
           etag = excluded.etag, last_modified = excluded.last_modified,
           fetched_at = excluded.fetched_at, ttl = excluded.ttl, size = excluded.size`,
      )
      .run(key, blob, contentType, etag, lastModified, fetchedAt, ttl, size);
    return {
      key,
      blobPath: join(this.blobDir, blob),
      contentType,
      etag,
      lastModified,
      fetchedAt,
      ttl,
      size,
    };
  }

  /** Refresh the stored timestamp after a 304, without rewriting the blob. */
  private touch(entry: CacheEntry): CacheEntry {
    const fetchedAt = Date.now();
    this.db.prepare('UPDATE cache SET fetched_at = ? WHERE key = ?').run(fetchedAt, entry.key);
    return { ...entry, fetchedAt };
  }

  /** Stream a response body to a content-addressed blob file. */
  private async store(response: Response): Promise<{ blob: string; size: number }> {
    const temporary = join(this.blobDir, `tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const hash = createHash('sha256');
    let size = 0;

    if (!response.body) {
      throw new Error('Upstream response had no body');
    }
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    await pipeline(source, createWriteStream(temporary));

    const blob = hash.digest('hex');
    try {
      renameSync(temporary, join(this.blobDir, blob));
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* already gone */
      }
      throw error;
    }
    return { blob, size };
  }

  /**
   * Fetch through the cache.
   *
   * Fresh entries are served without touching the network. Stale entries are
   * revalidated conditionally, so an unchanged upstream costs one 304. All of
   * it is wrapped in single-flight, so N concurrent misses cause exactly one
   * upstream fetch.
   */
  async fetch(request: UpstreamRequest & { ttl: number; key?: string }): Promise<CachedResult> {
    const key = request.key ?? request.url;

    const cached = this.read(key);
    if (cached && this.isFresh(cached)) {
      return { ...cached, fromCache: true, revalidated: false };
    }

    return this.flight.run(key, async () => {
      // Another caller may have populated the cache while we queued.
      const recheck = this.read(key);
      if (recheck && this.isFresh(recheck)) {
        return { ...recheck, fromCache: true, revalidated: false };
      }

      const headers: Record<string, string> = { ...request.headers };
      if (recheck?.etag) headers['if-none-match'] = recheck.etag;
      if (recheck?.lastModified) headers['if-modified-since'] = recheck.lastModified;

      this.upstreamFetches += 1;
      const response = await fetchUpstream({ ...request, headers });

      if (response.status === 304 && recheck) {
        await response.body?.cancel();
        return { ...this.touch(recheck), fromCache: true, revalidated: true };
      }

      if (!response.ok) {
        await response.body?.cancel();
        if (recheck) {
          // Upstream is unhappy but we have something. Serving stale beats
          // failing: these files do not change.
          return { ...recheck, fromCache: true, revalidated: true };
        }
        const error = new Error(`Upstream responded ${response.status}`) as Error & {
          statusCode: number;
        };
        error.statusCode = response.status === 404 ? 404 : 502;
        throw error;
      }

      const { blob, size } = await this.store(response);
      const entry = this.write(
        key,
        blob,
        response.headers.get('content-type') ?? 'application/octet-stream',
        response.headers.get('etag'),
        response.headers.get('last-modified'),
        request.ttl,
        size,
      );
      return { ...entry, fromCache: false, revalidated: false };
    });
  }

  /** Whole-blob read. Only for things we parse (catalogs), never for zips. */
  async readText(entry: CacheEntry): Promise<string> {
    return readFile(entry.blobPath, 'latin1');
  }

  async readBytes(entry: CacheEntry): Promise<Buffer> {
    return readFile(entry.blobPath);
  }

  stream(entry: CacheEntry): NodeJS.ReadableStream {
    return createReadStream(entry.blobPath);
  }
}

let instance: Cache | null = null;

export function getCache(): Cache {
  instance ??= new Cache();
  return instance;
}

export function setCache(cache: Cache | null): void {
  instance = cache;
}
