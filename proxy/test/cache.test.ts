/**
 * Cache behaviour against a real HTTP upstream.
 *
 * These are the guarantees the site owners are relying on: don't refetch what
 * you already have, revalidate cheaply, coalesce duplicates, and back off when
 * told to.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cache } from '../src/cache/index.js';
import { FakeUpstream } from './helpers/upstream.js';

let upstream: FakeUpstream;
let cache: Cache;
let dir: string;

beforeEach(async () => {
  upstream = new FakeUpstream();
  await upstream.start();
  dir = mkdtempSync(join(tmpdir(), 'hint-cache-'));
  cache = new Cache(dir);
});

afterEach(async () => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  await upstream.stop();
});

const allow = (): string[] => ['127.0.0.1'];

describe('cache', () => {
  it('misses, stores, then hits without touching the network', async () => {
    upstream.on('/file', () => ({ body: 'hello world' }));

    const first = await cache.fetch({ url: upstream.url('/file'), ttl: 60, allowlist: allow() });
    expect(first.fromCache).toBe(false);
    expect(await cache.readText(first)).toBe('hello world');

    const second = await cache.fetch({ url: upstream.url('/file'), ttl: 60, allowlist: allow() });
    expect(second.fromCache).toBe(true);
    expect(upstream.hitsFor('/file')).toBe(1);
  });

  it('addresses blobs by content, so identical bodies share storage', async () => {
    upstream.on('/a', () => ({ body: 'same bytes' }));
    upstream.on('/b', () => ({ body: 'same bytes' }));

    const a = await cache.fetch({ url: upstream.url('/a'), ttl: 60, allowlist: allow() });
    const b = await cache.fetch({ url: upstream.url('/b'), ttl: 60, allowlist: allow() });
    expect(a.blobPath).toBe(b.blobPath);
  });

  it('revalidates conditionally once stale and keeps the blob on a 304', async () => {
    upstream.on('/etag', ({ headers }) => {
      if (headers['if-none-match'] === '"v1"') return { status: 304, headers: { etag: '"v1"' } };
      return { body: 'version one', headers: { etag: '"v1"' } };
    });

    const first = await cache.fetch({ url: upstream.url('/etag'), ttl: 0, allowlist: allow() });
    expect(first.fromCache).toBe(false);

    const second = await cache.fetch({ url: upstream.url('/etag'), ttl: 0, allowlist: allow() });
    expect(second.revalidated).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(await cache.readText(second)).toBe('version one');
    expect(upstream.hitsFor('/etag')).toBe(2);
  });

  it('sends If-Modified-Since when only Last-Modified is known', async () => {
    const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';
    let conditional = false;
    upstream.on('/lm', ({ headers }) => {
      if (headers['if-modified-since'] === lastModified) {
        conditional = true;
        return { status: 304 };
      }
      return { body: 'body', headers: { 'last-modified': lastModified } };
    });

    await cache.fetch({ url: upstream.url('/lm'), ttl: 0, allowlist: allow() });
    await cache.fetch({ url: upstream.url('/lm'), ttl: 0, allowlist: allow() });
    expect(conditional).toBe(true);
  });

  it('replaces the blob when the upstream really did change', async () => {
    upstream.on('/changing', ({ hits }) => ({ body: hits === 1 ? 'old' : 'new' }));

    const first = await cache.fetch({ url: upstream.url('/changing'), ttl: 0, allowlist: allow() });
    expect(await cache.readText(first)).toBe('old');
    const second = await cache.fetch({ url: upstream.url('/changing'), ttl: 0, allowlist: allow() });
    expect(await cache.readText(second)).toBe('new');
  });

  it('coalesces concurrent misses into one upstream fetch', async () => {
    upstream.on('/slow', () => ({ body: 'shared', delayMs: 60 }));

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        cache.fetch({ url: upstream.url('/slow'), ttl: 60, allowlist: allow() }),
      ),
    );

    expect(upstream.hitsFor('/slow')).toBe(1);
    for (const result of results) expect(await cache.readText(result)).toBe('shared');
  });

  it('serves a stale copy when the upstream starts failing', async () => {
    upstream.on('/flaky', ({ hits }) =>
      hits === 1 ? { body: 'good' } : { status: 500, body: 'boom' },
    );

    await cache.fetch({ url: upstream.url('/flaky'), ttl: 0, allowlist: allow() });
    const stale = await cache.fetch({ url: upstream.url('/flaky'), ttl: 0, allowlist: allow() });
    expect(await cache.readText(stale)).toBe('good');
  });

  it('propagates an upstream failure when there is nothing cached', async () => {
    upstream.on('/gone', () => ({ status: 404, body: 'nope' }));
    await expect(
      cache.fetch({ url: upstream.url('/gone'), ttl: 60, allowlist: allow() }),
    ).rejects.toThrow(/404/);
  });

  it('follows redirects and re-checks the allowlist on each hop', async () => {
    upstream.on('/redirect', () => ({ status: 302, headers: { location: '/target' } }));
    upstream.on('/target', () => ({ body: 'arrived' }));

    const result = await cache.fetch({
      url: upstream.url('/redirect'),
      ttl: 60,
      allowlist: allow(),
    });
    expect(await cache.readText(result)).toBe('arrived');
  });

  it('refuses a redirect that leaves the allowlist', async () => {
    upstream.on('/escape', () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));

    await expect(
      cache.fetch({ url: upstream.url('/escape'), ttl: 60, allowlist: allow() }),
    ).rejects.toThrow(/not allowed/);
  });

  it('recovers from a blob deleted behind its back', async () => {
    upstream.on('/blob', () => ({ body: 'content' }));
    const first = await cache.fetch({ url: upstream.url('/blob'), ttl: 600, allowlist: allow() });
    rmSync(first.blobPath);

    const second = await cache.fetch({ url: upstream.url('/blob'), ttl: 600, allowlist: allow() });
    expect(second.fromCache).toBe(false);
    expect(await cache.readText(second)).toBe('content');
  });

  it('sends the configured User-Agent', async () => {
    let seen = '';
    upstream.on('/ua', ({ headers }) => {
      seen = String(headers['user-agent'] ?? '');
      return { body: 'ok' };
    });
    await cache.fetch({ url: upstream.url('/ua'), ttl: 60, allowlist: allow() });
    expect(seen).toContain('OmniUHS/1.0');
  });

  it('streams large bodies without buffering them', async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 0x41);
    upstream.on('/big', () => ({ body: megabyte }));
    const result = await cache.fetch({ url: upstream.url('/big'), ttl: 60, allowlist: allow() });
    expect(result.size).toBe(megabyte.length);
    expect((await cache.readBytes(result)).length).toBe(megabyte.length);
  });
});

describe('Retry-After', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks for the requested delay and then retries', async () => {
    upstream.on('/busy', ({ hits }) =>
      hits === 1
        ? { status: 429, headers: { 'retry-after': '1' }, body: 'slow down' }
        : { body: 'thanks for waiting' },
    );

    const pending = cache.fetch({ url: upstream.url('/busy'), ttl: 60, allowlist: allow() });
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(upstream.hitsFor('/busy')).toBe(2);
    expect(await cache.readText(result)).toBe('thanks for waiting');
  });

  it('gives up rather than parking for an unreasonable delay', async () => {
    upstream.on('/closed', () => ({
      status: 503,
      headers: { 'retry-after': '86400' },
      body: 'come back tomorrow',
    }));

    await expect(
      cache.fetch({ url: upstream.url('/closed'), ttl: 60, allowlist: allow() }),
    ).rejects.toThrow(/503/);
    expect(upstream.hitsFor('/closed')).toBe(1);
  });
});
