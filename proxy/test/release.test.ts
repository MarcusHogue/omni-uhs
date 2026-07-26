/**
 * Reading a published image's version out of a registry.
 *
 * The parsing rules here are the whole feature: get them wrong and the app
 * either reports an update that does not exist or stays silent about one that
 * does. Both were observed while building this.
 */

import { describe, expect, it } from 'vitest';

import { parseImage, versionFromConfig } from '../src/release.js';

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
