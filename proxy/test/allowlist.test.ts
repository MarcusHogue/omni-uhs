import { describe, expect, it } from 'vitest';

import { UpstreamRejected, assertAllowed, isAllowed } from '../src/upstream/allowlist.js';

const ALLOW = ['uhs-hints.com', 'www.uhs-hints.com', 'ifarchive.org'];

describe('upstream allowlist (SSRF boundary)', () => {
  it('accepts an allowlisted host', () => {
    expect(assertAllowed('https://www.uhs-hints.com/rfiles/zork1.zip', ALLOW).hostname).toBe(
      'www.uhs-hints.com',
    );
  });

  it('rejects a host that is not listed', () => {
    expect(() => assertAllowed('https://example.com/x', ALLOW)).toThrow(UpstreamRejected);
  });

  it('does not imply subdomains', () => {
    // www. must be listed separately; an attacker-controlled subdomain of an
    // allowed domain is still a different host.
    expect(isAllowed('https://evil.uhs-hints.com/x', ALLOW)).toBe(false);
  });

  it('rejects hosts that merely end with an allowed name', () => {
    expect(isAllowed('https://notuhs-hints.com/x', ALLOW)).toBe(false);
    expect(isAllowed('https://uhs-hints.com.evil.test/x', ALLOW)).toBe(false);
  });

  it('rejects non-http protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://ifarchive.org/x',
      'gopher://ifarchive.org/x',
      'data:text/plain,hello',
    ]) {
      expect(isAllowed(url, ALLOW)).toBe(false);
    }
  });

  it('rejects embedded credentials', () => {
    expect(isAllowed('https://user:pass@ifarchive.org/x', ALLOW)).toBe(false);
    // The classic confusion attack: the real host is evil.test.
    expect(isAllowed('https://ifarchive.org@evil.test/x', ALLOW)).toBe(false);
  });

  it('rejects internal addresses', () => {
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://10.0.0.5/',
    ]) {
      expect(isAllowed(url, ALLOW)).toBe(false);
    }
  });

  it('ignores case and a trailing dot on the hostname', () => {
    expect(isAllowed('https://IFArchive.ORG/x', ALLOW)).toBe(true);
    expect(isAllowed('https://ifarchive.org./x', ALLOW)).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isAllowed('not a url', ALLOW)).toBe(false);
    expect(isAllowed('', ALLOW)).toBe(false);
  });
});
