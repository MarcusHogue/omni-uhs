/**
 * The SSRF boundary.
 *
 * Every outbound URL is parsed and its hostname checked against an explicit
 * allowlist — before the request, and again on every redirect hop, because a
 * 302 to an internal address is the whole point of the attack.
 */

export class UpstreamRejected extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamRejected';
  }
}

/**
 * Validate a URL against an allowlist.
 *
 * Requires http/https, forbids credentials in the URL, and matches the
 * hostname exactly (case-insensitively). Subdomains are *not* implied: if
 * `www.example.com` should be reachable, it has to be listed.
 */
export function assertAllowed(rawUrl: string, allowlist: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamRejected(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UpstreamRejected(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpstreamRejected('Credentials in upstream URLs are not allowed');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!allowlist.includes(host)) {
    throw new UpstreamRejected(`Upstream host not allowed: ${host}`);
  }
  return url;
}

export function isAllowed(rawUrl: string, allowlist: readonly string[]): boolean {
  try {
    assertAllowed(rawUrl, allowlist);
    return true;
  } catch {
    return false;
  }
}
