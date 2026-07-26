/**
 * Knowing when a newer build exists.
 *
 * Two independent signals, because they catch different failures:
 *
 * 1. **A waiting service worker.** New assets are already downloaded and sitting
 *    in `waiting`; applying it is instant and works offline. This is the normal
 *    case and the only one that can actually *do* anything about the update.
 * 2. **A version mismatch.** The proxy reports a different build than the one
 *    baked into this bundle. That catches the case the service worker cannot
 *    see: one container updated and the other did not, or a browser holding a
 *    bundle from before the last deploy without having noticed a new worker
 *    yet. It is diagnostic — reloading may or may not fix it, and if only the
 *    proxy moved, nothing in the browser will.
 * 3. **A newer image in the registry.** Neither of the above can see this, and
 *    that was the gap: both compare the browser against the server, so until
 *    someone pulls, every part of the stack agrees and the app says nothing —
 *    while a release sits unnoticed. The proxy asks GHCR what `:latest` is; the
 *    answer is a build nobody has installed, so there is nothing to reload and
 *    the only fix is `docker compose pull` on the host.
 *
 * All are suppressed when either side reports `dev`: a hand-built image has no
 * meaningful version, and comparing it to anything produces noise.
 */

import { registerSW } from 'virtual:pwa-register';

import { api, type ImageRelease } from '../api/client';

/** The build this bundle was made from. `dev` outside a Docker build. */
export const WEB_VERSION: string = __APP_VERSION__;

/**
 * The registry's answer, reduced to what the UI acts on.
 *
 * `images` is kept whole for Settings, which is worth being precise in: the two
 * publish independently, so "web is behind but the proxy is current" is a state
 * that really happens and is worth naming rather than averaging away.
 */
export interface ReleaseSummary {
  /** The build to pull, when the two agree. Null when they do not. */
  version: string | null;
  images: ImageRelease[];
  /** Images whose published build differs from what is running here. */
  behind: string[];
  /**
   * What exactly is being offered, as `name@digest` per behind image.
   *
   * The dismissal key. A version name cannot serve: an image without a label
   * has none, so every unlabelled release after the first would reuse the same
   * key and be silently swallowed. A manifest hash always exists and changes
   * exactly when the image does.
   */
  identity: string;
  /**
   * Images the comparison could not settle.
   *
   * Kept separate from `behind` and never folded into it. An unsettled image is
   * not a current one, and "only the proxy is behind" would be a claim about
   * the web image that nothing checked.
   */
  unknown: string[];
}

export const isReleaseBuild = (version: string): boolean =>
  version !== 'dev' && version.length > 0;

export type UpdateReason = 'service-worker' | 'version-mismatch' | 'registry-release';

export interface UpdateState {
  /** A new service worker is waiting; `apply()` will activate it. */
  waiting: boolean;
  /** The proxy is on a different build than this bundle. */
  mismatch: boolean;
  /** A build exists in the registry that this deployment has not pulled. */
  release: ReleaseSummary | null;
  proxyVersion: string | null;
  /**
   * Whether the proxy has actually answered a version request. Without this,
   * "not checked yet" and "checked and matching" are indistinguishable, and the
   * UI would report a successful comparison that never happened — offline, that
   * would be permanent.
   */
  checked: boolean;
  reason: UpdateReason | null;
}

type Listener = (state: UpdateState) => void;

const state: UpdateState = {
  waiting: false,
  mismatch: false,
  release: null,
  proxyVersion: null,
  checked: false,
  reason: null,
};

const listeners = new Set<Listener>();

/**
 * Which of the three to name, when more than one is true.
 *
 * Most actionable first. A waiting worker is one tap and it is done; a mismatch
 * is usually one reload away; a registry release needs a shell on the NAS, so
 * it is the one to mention when nothing closer to hand is pending.
 */
const derive = (): void => {
  state.reason = state.waiting
    ? 'service-worker'
    : state.mismatch
      ? 'version-mismatch'
      : (state.release?.behind.length ?? 0) > 0
        ? 'registry-release'
        : null;
  for (const listener of listeners) listener({ ...state });
};

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export const getUpdateState = (): UpdateState => ({ ...state });

/** Set by `startUpdateWatch`; activates the waiting worker. */
let applyUpdate: (() => Promise<void>) | null = null;

/**
 * Apply an update.
 *
 * Only route through the service worker when one is actually waiting.
 * `updateServiceWorker` ignores its `reloadPage` argument entirely — it just
 * posts SKIP_WAITING, and the reload comes from a `controlling` listener the
 * plugin only attaches once a worker has reached `waiting`. With nothing
 * waiting it is a no-op, so a mismatch-only state has to reload the page
 * itself or the button does nothing at all.
 */
export async function applyWaitingUpdate(): Promise<void> {
  if (state.waiting && applyUpdate) {
    await applyUpdate();
    return;
  }
  location.reload();
}

/** Ask the browser to re-check for a new service worker, on demand. */
let checkForUpdate: (() => Promise<void>) | null = null;

export async function checkNow(): Promise<UpdateState> {
  await checkForUpdate?.();
  await refreshProxyVersion();
  await refreshRelease();
  return getUpdateState();
}

/**
 * Ask the proxy what the registry is offering.
 *
 * This bundle's own version goes with the request: the web image's build is
 * compiled in here, not readable from the container, so the server cannot
 * compare that image against `:latest` without being told what is running.
 */
export async function refreshRelease(): Promise<void> {
  if (!isReleaseBuild(WEB_VERSION)) return;
  try {
    const status = await api.release(WEB_VERSION);
    if (!status.enabled) {
      state.release = null;
      derive();
      return;
    }

    // Settled server-side, per image, by comparing manifests — the only
    // comparison that works on an image carrying no version label. `null` means
    // "could not tell", which is deliberately not treated as current.
    const behind = status.images
      .filter((image) => image.current === false)
      .map((image) => image.name);

    // Name the build from the images that are actually *behind*. Taking it from
    // every image collapses to null the moment one is current and the other is
    // not — which is precisely the case worth naming — and that null then makes
    // two different releases share a dismissal key.
    const versions = new Set(
      status.images
        .filter((image) => image.current === false)
        .map((image) => image.available)
        .filter((v): v is string => v !== null),
    );

    state.release = {
      version: versions.size === 1 ? [...versions][0]! : null,
      images: status.images,
      behind,
      // The published manifests of the images that are behind. This is what a
      // dismissal is keyed on: it exists for an unlabelled image, and it
      // changes exactly when the image does.
      identity: status.images
        .filter((image) => image.current === false)
        .map((image) => `${image.name}@${image.digest ?? image.available ?? 'unknown'}`)
        .join(','),
      unknown: status.images.filter((image) => image.current === null).map((image) => image.name),
    };
    derive();
  } catch {
    /* offline, or an older proxy with no /api/release. Not an update. */
  }
}

/**
 * Compare the proxy's build with ours.
 *
 * Failure is silence, not an error: this runs on a timer, the app is expected
 * to work offline, and a failed version check is not something to interrupt
 * anyone about.
 */
export async function refreshProxyVersion(): Promise<void> {
  if (!isReleaseBuild(WEB_VERSION)) return;
  try {
    const response = await fetch('/api/version', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return;
    const body = (await response.json()) as { version?: string };
    const proxyVersion = typeof body.version === 'string' ? body.version : null;
    state.proxyVersion = proxyVersion;
    state.checked = proxyVersion !== null;
    state.mismatch =
      proxyVersion !== null &&
      isReleaseBuild(proxyVersion) &&
      proxyVersion !== WEB_VERSION;
    derive();
  } catch {
    /* offline, or the proxy is down. Neither is an update. */
  }
}

/** How often to re-compare with the proxy while the app is open. */
const POLL_MS = 30 * 60 * 1000;

/**
 * Register the service worker and start watching for newer builds.
 *
 * Called once, before React mounts. Registration is what makes the app work
 * offline at all, so it happens regardless of whether this is a release build;
 * only the version comparison is release-only.
 */
export function startUpdateWatch(): void {
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      state.waiting = true;
      derive();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      checkForUpdate = async () => {
        try {
          await registration.update();
        } catch {
          /* offline; nothing to check against */
        }
      };
    },
  });
  applyUpdate = async () => {
    await update(true);
  };

  // Order matters: the release comparison needs the proxy's own version to
  // know what the proxy image is running.
  const poll = async (): Promise<void> => {
    await refreshProxyVersion();
    await refreshRelease();
  };

  void poll();
  setInterval(() => void poll(), POLL_MS);
  // Coming back to a backgrounded tab is the moment a stale build shows up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
  });
}

/* --------------------------------------------------------------- dismissal */

const DISMISS_KEY = 'omni-uhs:update-dismissed';

/**
 * The reasons are dismissed differently, because only some have anything stable
 * to key on.
 *
 * A **mismatch** names a specific proxy build, and a **registry release** names
 * the build waiting to be pulled. Both persist against that version, so the
 * next differing build asks again.
 *
 * A **waiting service worker** has no such name: the page cannot see the
 * version of the build sitting in `waiting` — that number lives inside the new
 * bundle, not this one — and the proxy's version is no substitute, since the
 * two images publish independently and the proxy may not have moved at all.
 * Keying on it would silently swallow the notice for a later web build. So this
 * one is dismissed for the session only: gone until the next launch, where it
 * is one tap away and worth mentioning once more.
 */
export const dismissalKey = (state: UpdateState): string => {
  if (state.reason === 'version-mismatch') {
    return `version-mismatch:${state.proxyVersion ?? 'unknown'}`;
  }
  if (state.reason === 'registry-release') {
    // Keyed on which images are behind and exactly what each is offering, so a
    // later release always asks again — including for an image that carries no
    // version label and can only be told apart by its manifest.
    return `registry-release:${state.release?.identity ?? 'unknown'}`;
  }
  return `${state.reason ?? 'none'}:session`;
};

const persists = (reason: UpdateReason | null): boolean =>
  reason === 'version-mismatch' || reason === 'registry-release';

/** Session-scoped dismissals, for the states with no durable identity. */
const dismissedThisSession = new Set<string>();

/**
 * Persisted dismissals, as a list rather than a single value.
 *
 * Two reasons persist now, and one slot would let a mismatch dismissal evict a
 * release dismissal — quietly resurrecting a notice the user had already waved
 * away. Trimmed to the most recent few, since a key names one build and old
 * ones can never match again.
 */
const KEEP = 8;

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return [];
    // Tolerates the single-string value written by earlier builds.
    const parsed: unknown = raw.startsWith('[') ? JSON.parse(raw) : [raw];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function isDismissed(state: UpdateState): boolean {
  if (state.reason === null) return false;
  const key = dismissalKey(state);
  if (!persists(state.reason)) return dismissedThisSession.has(key);
  return readDismissed().includes(key) || dismissedThisSession.has(key);
}

export function dismiss(state: UpdateState): void {
  if (state.reason === null) return;
  const key = dismissalKey(state);
  dismissedThisSession.add(key);
  if (!persists(state.reason)) return;
  try {
    const kept = [key, ...readDismissed().filter((k) => k !== key)].slice(0, KEEP);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(kept));
  } catch {
    /* private mode: the session-scoped copy above still applies */
  }
}
