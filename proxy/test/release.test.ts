/**
 * Reading a published image's version out of a registry.
 *
 * The parsing rules here are the whole feature: get them wrong and the app
 * either reports an update that does not exist or stays silent about one that
 * does. Both were observed while building this.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cache } from '../src/cache/index.js';
import { config } from '../src/config.js';
import { checkRelease, parseImage, versionFromConfig } from '../src/release.js';

describe('image references', () => {
  it('splits a GHCR reference into the parts the API needs', () => {
    expect(parseImage('ghcr.io/someone/omni-uhs-proxy')).toEqual({
      name: 'proxy',
      reference: 'ghcr.io/someone/omni-uhs-proxy',
      repository: 'someone/omni-uhs-proxy',
    });
  });

  it('ignores a tag, since the check is always against :latest', () => {
    expect(parseImage('ghcr.io/someone/omni-uhs-web:latest')?.repository).toBe(
      'someone/omni-uhs-web',
    );
  });

  it('keeps the full name when it is not one of ours', () => {
    expect(parseImage('ghcr.io/someone/other-thing')?.name).toBe('other-thing');
  });

  it('refuses a registry whose auth flow this does not implement', () => {
    // Silently not-checking would be indistinguishable from "up to date".
    expect(parseImage('docker.io/library/caddy')).toBeNull();
    expect(parseImage('registry.example.com/x/y')).toBeNull();
    expect(parseImage('ghcr.io/nope')).toBeNull();
    expect(parseImage('')).toBeNull();
  });
});

// The label only names the build; whether an update exists is settled by
// comparing manifests, which needs no label at all. These cover the naming.
describe('version from an image config', () => {
  it('reads the private build label', () => {
    expect(
      versionFromConfig({ config: { Labels: { 'com.omni-uhs.build': '2c6bbad' } } }),
    ).toBe('2c6bbad');
  });

  it('never reads the standard version label, which is inherited', () => {
    // The web image is FROM caddy:2-alpine, which sets this. Reading it
    // reported Caddy's version as an available update -- observed, not
    // hypothetical, which is why the key we read is a private one.
    expect(
      versionFromConfig({
        config: {
          Labels: {
            'org.opencontainers.image.version': 'v2.11.4',
            'org.opencontainers.image.title': 'Caddy',
          },
        },
      }),
    ).toBeNull();
  });

  it('prefers the label over the environment when both are present', () => {
    expect(
      versionFromConfig({
        config: {
          Labels: { 'com.omni-uhs.build': '9f31c02' },
          Env: ['APP_VERSION=2c6bbad'],
        },
      }),
    ).toBe('9f31c02');
  });

  it('falls back to APP_VERSION for images built before the label', () => {
    expect(
      versionFromConfig({ config: { Env: ['PATH=/usr/bin', 'APP_VERSION=2c6bbad'] } }),
    ).toBe('2c6bbad');
  });

  it('reports nothing rather than guessing', () => {
    // An unnamed image is still compared correctly; only the label is missing.
    expect(versionFromConfig({})).toBeNull();
    expect(versionFromConfig({ config: { Env: ['APP_VERSION='] } })).toBeNull();
    expect(versionFromConfig({ config: { Labels: { 'com.omni-uhs.build': '  ' } } })).toBeNull();
  });
});

/**
 * The cache key for the `:latest` read.
 *
 * The cache is a named volume, so it outlives the container and therefore the
 * upgrade that changes what is running. Keyed on the URL alone, a six-hour entry
 * written before an upgrade was still served afterwards — and since the running
 * tag resolved fresh to the new manifest, the two digests differed and the app
 * reported the build it had just replaced as an available update.
 *
 * This is the regression: 8293df1 was told its own parent, 89193c6, was newer
 * than itself, for up to six hours, with no way to clear it from the UI.
 */
describe('the :latest lookup after an upgrade', () => {
  /** Answer every registry call, and record the keys asked for. */
  function stub(): { cache: Cache; keys: () => (string | undefined)[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hint-release-'));
    const cache = new Cache(dir);
    const bodies = new Map<string, string>();
    vi.spyOn(cache, 'fetch').mockImplementation((request: never) => {
      const { url, key } = request as { url: string; key?: string };
      const body = url.includes('/token')
        ? JSON.stringify({ token: 't' })
        : JSON.stringify({ manifests: [] });
      bodies.set(key ?? url, body);
      return Promise.resolve({ key: key ?? url, path: '', contentType: 'application/json' } as never);
    });
    vi.spyOn(cache, 'readText').mockImplementation((entry: never) =>
      Promise.resolve(bodies.get((entry as { key: string }).key) ?? '{}'),
    );
    return {
      cache,
      keys: () =>
        (cache.fetch as unknown as { mock: { calls: [{ key?: string }][] } }).mock.calls.map(
          (call) => call[0].key,
        ),
    };
  }

  const realVersion = config.version;
  afterEach(() => {
    config.version = realVersion;
    vi.restoreAllMocks();
  });

  it('keys the answer on the running build, so an upgrade cannot reuse it', async () => {
    // A hand-built proxy reports `dev` and the whole check is skipped, which is
    // deliberate -- comparing `dev` to a published SHA would claim an update on
    // every launch. Stand in a published-looking build so there is a check to make.
    config.version = 'bbbbbbb';
    const { cache, keys } = stub();
    await checkRelease(cache, 'aaaaaaa');

    const latest = keys().filter((key) => key?.startsWith('ghcr:latest:'));
    expect(latest.length).toBeGreaterThan(0);
    // The proxy's own build for the proxy image, the browser's for the web one:
    // each is compared against whatever is running it.
    expect(latest.some((key) => key?.endsWith(':bbbbbbb'))).toBe(true);
    expect(latest.some((key) => key?.endsWith(':aaaaaaa'))).toBe(true);
  });

  it('asks again once the running build changes', async () => {
    config.version = 'bbbbbbb';
    const first = stub();
    await checkRelease(first.cache, 'aaaaaaa');
    const before = first.keys().filter((key) => key?.startsWith('ghcr:latest:'));

    // The upgrade. Same repository, same URL -- only the deployment moved on.
    config.version = 'ccccccc';
    const second = stub();
    await checkRelease(second.cache, 'aaaaaaa');
    const after = second.keys().filter((key) => key?.startsWith('ghcr:latest:'));

    // No key survives the upgrade for the proxy image, so its stale answer
    // cannot be read back. The web image did not move, and keeps its entry.
    expect(after).not.toContain(before.find((key) => key?.endsWith(':bbbbbbb')));
    expect(after.some((key) => key?.endsWith(':ccccccc'))).toBe(true);
    expect(after.some((key) => key?.endsWith(':aaaaaaa'))).toBe(true);
  });
});
