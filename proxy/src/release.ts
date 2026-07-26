/**
 * Is there a newer image than the one running?
 *
 * This is a different question from the one the update banner used to answer.
 * A service worker notices that the *browser* is behind the *server*; neither
 * side can notice that a build exists which nobody has pulled, because nothing
 * in the stack talks to the registry. So this does.
 *
 * A registry has no "what version is this" API, and the obvious substitute — a
 * version label on the image — only works for images built after the label was
 * added, which is a poor answer to "is my deployment current". So the question
 * is asked a way that needs nothing published alongside the image and no
 * cooperation from the build that made it:
 *
 *   **`:latest` and `:<the tag I am running>` either name the same manifest or
 *   they do not.**
 *
 * Same manifest, same image, nothing to pull. Different, and there is. Two
 * requests, no labels, and it works on every image already in the registry.
 *
 * The label is still read, because "a newer build is available" is friendlier
 * when it can say *which* — but it names the answer, it does not decide it, and
 * an image without one is compared just as well.
 *
 * All of it is anonymous, for public images, behind a six-hour cache, and only
 * when something asks. Reading the label follows a redirect to a signed CDN URL
 * on a second host, so both are in the per-request allowlist and neither is
 * added to the global one.
 */

import { createHash } from 'node:crypto';

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
  /**
   * Whether `:latest` is the same image as the tag being run.
   *
   * The load-bearing field. `null` means the question could not be settled —
   * the registry was unreachable, or the running build has no tag there — which
   * is not the same as "up to date" and must never be shown as such.
   */
  current: boolean | null;
  /**
   * The build `:latest` was made from, when the image says so.
   *
   * Cosmetic: it names the build in the UI. Absent on images published before
   * the version label existed, which is exactly why it cannot be what decides
   * whether an update exists.
   */
  available: string | null;
  /** The version this deployment is running for this image. */
  running: string | null;
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

const readRaw = async (
  cache: Cache,
  url: string,
  ttl: number,
  headers: Record<string, string>,
  key?: string,
): Promise<string> => {
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
  return cache.readText(entry);
};

const readJson = async <T>(
  cache: Cache,
  url: string,
  ttl: number,
  headers: Record<string, string>,
  key?: string,
): Promise<T> => JSON.parse(await readRaw(cache, url, ttl, headers, key)) as T;

/**
 * An image's identity, as a hash of its manifest.
 *
 * This is what makes the check work on images built before the version label
 * existed — which, at the time of writing, is every image published. Two tags
 * naming the same manifest are the same image; that is the whole comparison,
 * and it needs nothing baked in, nothing published alongside, and no
 * cooperation from the build.
 *
 * Hashed here rather than read from `Docker-Content-Digest` because the cache
 * hands back bodies, not headers — and equality is all this is for, so it would
 * hold even if the registry hashed differently.
 */
const digestOf = (raw: string): string => createHash('sha256').update(raw).digest('hex');

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

/**
 * Ask the registry about one image.
 *
 * Two questions, in order of importance: is `:latest` a different image from
 * the one running, and if so what is it called. The first is answered by
 * comparing manifests and always works; the second needs a label the image may
 * not carry, so it is attempted and allowed to fail.
 */
async function inspect(
  cache: Cache,
  image: ParsedImage,
  running: string | null,
): Promise<{ current: boolean | null; available: string | null }> {
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

  const latestRaw = await readRaw(cache, `${manifests}/latest`, config.ttl.release, headers);

  // The comparison. A tag that is not there means the running build was never
  // published under that name — reported as unknown, never as up to date.
  let current: boolean | null = null;
  if (running && running !== 'dev') {
    try {
      const runningRaw = await readRaw(
        cache,
        `${manifests}/${encodeURIComponent(running)}`,
        config.ttl.release,
        headers,
      );
      current = digestOf(latestRaw) === digestOf(runningRaw);
    } catch {
      current = null;
    }
  }

  // The name, when the image carries one. Best effort by design: an image
  // published before the label existed still compares correctly above.
  let available: string | null = null;
  try {
    const index = JSON.parse(latestRaw) as OciIndex;
    // A single-platform push is a manifest already; a buildx push is an index.
    const digest = platformDigest(index);
    const manifest = digest
      ? await readJson<OciIndex>(cache, `${manifests}/${digest}`, config.ttl.release, headers)
      : index;
    const configDigest = manifest.config?.digest;
    if (configDigest) {
      // Keyed on the digest, not the URL: the blob redirects to a signed CDN
      // link that is unique per request, so caching by URL would never hit. A
      // digest is content-addressed, so this entry can never go stale.
      const blob = await readJson<OciConfig>(
        cache,
        `https://${GHCR}/v2/${image.repository}/blobs/${configDigest}`,
        config.ttl.file,
        headers,
        `ghcr:config:${configDigest}`,
      );
      available = versionFromConfig(blob);
    }
  } catch {
    /* the name is a nicety; the comparison above already stands */
  }

  return { current, available };
}

/**
 * What the registry is offering.
 *
 * Never throws: a registry that is unreachable is not news, and the caller has
 * a perfectly good answer already — the version it is running.
 */
export async function checkRelease(
  cache: Cache,
  /**
   * What the *browser* is running, which only the browser knows: the web
   * image's version lives inside its JS bundle. Without it the web image can
   * still be reported, but not compared.
   */
  webVersion?: string,
): Promise<ReleaseStatus> {
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
      // Each image is compared against whatever is running *it*. They publish
      // independently, so one can be behind while the other is current.
      const runningHere =
        target.name === 'web' ? (webVersion?.trim() || null) : running;
      try {
        const { current, available } = await inspect(cache, target, runningHere);
        return {
          name: target.name,
          reference: target.reference,
          current,
          available,
          running: runningHere,
        };
      } catch (error) {
        return {
          name: target.name,
          reference: target.reference,
          current: null,
          available: null,
          running: runningHere,
          error: (error as Error).message,
        };
      }
    }),
  );

  const behind = images.filter((image) => image.current === false);
  log.upstream.info(
    {
      running,
      state: Object.fromEntries(images.map((i) => [i.name, i.current])),
      available: Object.fromEntries(images.map((i) => [i.name, i.available])),
      ms: since(started),
    },
    behind.length > 0
      ? `a newer build is published for: ${behind.map((i) => i.name).join(', ')}`
      : `running the published build (${running})`,
  );

  return {
    enabled: true,
    running,
    images,
    checkedAt: new Date().toISOString(),
  };
}
