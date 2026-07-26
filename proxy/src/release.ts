/**
 * Is there a newer image than the one running?
 *
 * This is a different question from the one the update banner used to answer.
 * A service worker notices that the *browser* is behind the *server*; neither
 * side can notice that a build exists which nobody has pulled, because nothing
 * in the stack talks to the registry. So this does: it asks GHCR what
 * `:latest` currently is and reports the version baked into it.
 *
 * How the version is read, since a registry has no "what version is this" API:
 *
 *   1. `GET /token?scope=repository:<repo>:pull` — anonymous, for a public
 *      image. No credentials are stored or sent.
 *   2. `GET /v2/<repo>/manifests/latest` — an OCI *index*, listing one manifest
 *      per platform plus, on a buildx push, an `unknown/unknown` attestation
 *      entry that must not be mistaken for the image.
 *   3. `GET /v2/<repo>/manifests/<platform digest>` — names the config blob.
 *   4. `GET /v2/<repo>/blobs/<config digest>` — the image config, whose `Env`
 *      carries the `APP_VERSION` the publish workflow stamped in.
 *
 * Four requests per image, behind a six-hour cache, and only when something
 * asks. The blob step redirects to a signed CDN URL on a second host, so both
 * are in the per-request allowlist and neither is added to the global one.
 */

import { config } from './config.js';
import type { Cache } from './cache/index.js';
import { log, since } from './log.js';

/** The two hosts a GHCR read touches. Nothing else is reachable from here. */
const GHCR = 'ghcr.io';
const GHCR_BLOBS = 'pkg-containers.githubusercontent.com';
const ALLOWLIST = [GHCR, GHCR_BLOBS];

export interface ImageRelease {
  /** Short label — "proxy", "web" — matching what the image serves. */
  name: string;
  reference: string;
  /** `APP_VERSION` of the published `:latest`, or null if it could not be read. */
  available: string | null;
  error?: string;
}

export interface ReleaseStatus {
  /** Off for a hand-built image, or when RELEASE_IMAGES is empty. */
  enabled: boolean;
  /** What this proxy is running, for the client to compare against. */
  running: string;
  images: ImageRelease[];
  checkedAt: string | null;
}

interface ParsedImage {
  name: string;
  reference: string;
  repository: string;
}

/**
 * Split `ghcr.io/owner/omni-uhs-proxy` into the parts the API needs.
 *
 * Anything not on ghcr.io is rejected rather than guessed at: every registry
 * has its own auth flow, and silently not-checking would look identical to
 * "you are up to date".
 */
export function parseImage(reference: string): ParsedImage | null {
  const trimmed = reference.trim().replace(/:.*$/, '');
  if (!trimmed.startsWith(`${GHCR}/`)) return null;
  const repository = trimmed.slice(GHCR.length + 1);
  if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/.test(repository)) return null;
  const last = repository.split('/').pop()!;
  return { name: last.replace(/^omni-uhs-/, ''), reference: trimmed, repository };
}

interface TokenPayload {
  token?: string;
}

interface OciIndex {
  manifests?: {
    digest?: string;
    platform?: { os?: string; architecture?: string };
  }[];
  config?: { digest?: string };
}

interface OciConfig {
  config?: { Env?: string[]; Labels?: Record<string, string> };
}

const readJson = async <T>(
  cache: Cache,
  url: string,
  ttl: number,
  headers: Record<string, string>,
  key?: string,
): Promise<T> => {
  const entry = await cache.fetch({
    url,
    ttl,
    accept:
      'application/vnd.oci.image.index.v1+json,' +
      'application/vnd.docker.distribution.manifest.list.v2+json,' +
      'application/vnd.oci.image.manifest.v1+json,' +
      'application/vnd.oci.image.config.v1+json,application/json',
    allowlist: ALLOWLIST,
    headers,
    ...(key ? { key } : {}),
  });
  return JSON.parse(await cache.readText(entry)) as T;
};

/**
 * The platform image inside an index.
 *
 * `unknown/unknown` is the attestation manifest buildx attaches; reading its
 * config would yield no `APP_VERSION` and look like a failed check. Position is
 * not a safe proxy for identity, so the platform is matched explicitly.
 */
const platformDigest = (index: OciIndex): string | null =>
  index.manifests?.find(
    (entry) =>
      entry.platform?.os !== undefined &&
      entry.platform.os !== 'unknown' &&
      entry.platform.architecture !== 'unknown',
  )?.digest ?? null;

/**
 * What build a published image is.
 *
 * Read from `com.omni-uhs.build`, and pointedly **not** from
 * `org.opencontainers.image.version`. Labels are inherited from the base image,
 * so the standard key on the web image reads `v2.11.4` — Caddy's version,
 * looking exactly like a plausible answer. Observed, not theorised: the first
 * version of this function reported it as an available update. A private key
 * cannot be inherited by accident.
 *
 * `APP_VERSION` is a fallback for images published before the label existed.
 * It only ever works for the proxy: the web image's runtime stage is stock
 * Caddy, so the build arg never reaches it and its version lives inside the JS
 * bundle, where only a browser can see it. That blind spot is why the label
 * exists.
 */
export function versionFromConfig(image: OciConfig): string | null {
  const labelled = image.config?.Labels?.['com.omni-uhs.build']?.trim();
  if (labelled) return labelled;
  const found = (image.config?.Env ?? []).find((entry) => entry.startsWith('APP_VERSION='));
  const value = found?.slice('APP_VERSION='.length).trim();
  return value ? value : null;
}

async function publishedVersion(cache: Cache, image: ParsedImage): Promise<string | null> {
  const auth = await readJson<TokenPayload>(
    cache,
    `https://${GHCR}/token?scope=${encodeURIComponent(`repository:${image.repository}:pull`)}&service=${GHCR}`,
    // Short: the token expires in minutes, and it is one request per check.
    60,
    {},
  );
  if (!auth.token) throw new Error('the registry issued no pull token');
  const headers = { authorization: `Bearer ${auth.token}` };

  const manifests = `https://${GHCR}/v2/${image.repository}/manifests`;
  const index = await readJson<OciIndex>(cache, `${manifests}/latest`, config.ttl.release, headers);

  // A single-platform push is a manifest already; a buildx push is an index.
  const digest = platformDigest(index);
  const manifest = digest
    ? await readJson<OciIndex>(cache, `${manifests}/${digest}`, config.ttl.release, headers)
    : index;

  const configDigest = manifest.config?.digest;
  if (!configDigest) throw new Error('the manifest names no image config');

  // Keyed on the digest, not the URL: the blob redirects to a signed CDN link
  // that is unique per request, so caching by URL would never hit. A digest is
  // content-addressed, so this entry can never go stale.
  const blob = await readJson<OciConfig>(
    cache,
    `https://${GHCR}/v2/${image.repository}/blobs/${configDigest}`,
    config.ttl.file,
    headers,
    `ghcr:config:${configDigest}`,
  );
  const version = versionFromConfig(blob);
  if (!version) {
    // Silence here would read as "you are up to date", which is the one thing
    // this must never imply when it does not know.
    throw new Error('the published image declares no version label');
  }
  return version;
}

/**
 * What the registry is offering.
 *
 * Never throws: a registry that is unreachable is not news, and the caller has
 * a perfectly good answer already — the version it is running.
 */
export async function checkRelease(cache: Cache): Promise<ReleaseStatus> {
  const running = config.version;
  const parsed = config.releaseImages
    .map((reference) => ({ reference, image: parseImage(reference) }))
    .filter((row) => row.image !== null);

  // A hand-built image has no version worth comparing, and comparing `dev` to a
  // published SHA would report an update on every launch.
  if (running === 'dev' || parsed.length === 0) {
    return { enabled: false, running, images: [], checkedAt: null };
  }

  const started = performance.now();
  const images = await Promise.all(
    parsed.map(async ({ image }): Promise<ImageRelease> => {
      const target = image!;
      try {
        return {
          name: target.name,
          reference: target.reference,
          available: await publishedVersion(cache, target),
        };
      } catch (error) {
        return {
          name: target.name,
          reference: target.reference,
          available: null,
          error: (error as Error).message,
        };
      }
    }),
  );

  const newer = images.filter((image) => image.available && image.available !== running);
  log.upstream.info(
    {
      running,
      available: Object.fromEntries(images.map((i) => [i.name, i.available])),
      ms: since(started),
    },
    newer.length > 0
      ? `a newer build is published: ${newer.map((i) => `${i.name} ${i.available}`).join(', ')}`
      : `running the published build (${running})`,
  );

  return {
    enabled: true,
    running,
    images,
    checkedAt: new Date().toISOString(),
  };
}
