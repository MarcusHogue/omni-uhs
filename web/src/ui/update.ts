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
 *
 * Both are suppressed when either side reports `dev`: a hand-built image has no
 * meaningful version, and comparing it to anything produces noise.
 */

import { registerSW } from 'virtual:pwa-register';

/** The build this bundle was made from. `dev` outside a Docker build. */
export const WEB_VERSION: string = __APP_VERSION__;

export const isReleaseBuild = (version: string): boolean =>
  version !== 'dev' && version.length > 0;

export type UpdateReason = 'service-worker' | 'version-mismatch';

export interface UpdateState {
  /** A new service worker is waiting; `apply()` will activate it. */
  waiting: boolean;
  /** The proxy is on a different build than this bundle. */
  mismatch: boolean;
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
  proxyVersion: null,
  checked: false,
  reason: null,
};

const listeners = new Set<Listener>();

const derive = (): void => {
  state.reason = state.waiting
    ? 'service-worker'
    : state.mismatch
      ? 'version-mismatch'
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
  return getUpdateState();
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

  void refreshProxyVersion();
  setInterval(() => void refreshProxyVersion(), POLL_MS);
  // Coming back to a backgrounded tab is the moment a stale build shows up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshProxyVersion();
  });
}

/* --------------------------------------------------------------- dismissal */

const DISMISS_KEY = 'omni-uhs:update-dismissed';

/**
 * The two reasons are dismissed differently, because only one of them has
 * anything stable to key on.
 *
 * A **mismatch** names a specific proxy build, so the dismissal persists
 * against that version and the next differing build asks again.
 *
 * A **waiting service worker** does not: the page cannot see the version of the
 * build sitting in `waiting` — that number lives inside the new bundle, not
 * this one — and the proxy's version is no substitute, since the two images
 * publish independently and the proxy may not have moved at all. Keying on it
 * would silently swallow the notice for a later web build. So this one is
 * dismissed for the session only: gone until the next launch, where it is one
 * tap away and worth mentioning once more.
 */
export const dismissalKey = (state: UpdateState): string =>
  state.reason === 'version-mismatch'
    ? `version-mismatch:${state.proxyVersion ?? 'unknown'}`
    : `${state.reason ?? 'none'}:session`;

/** Session-scoped dismissals, for the states with no durable identity. */
const dismissedThisSession = new Set<string>();

export function isDismissed(state: UpdateState): boolean {
  if (state.reason === null) return false;
  if (state.reason !== 'version-mismatch') {
    return dismissedThisSession.has(dismissalKey(state));
  }
  try {
    return localStorage.getItem(DISMISS_KEY) === dismissalKey(state);
  } catch {
    return dismissedThisSession.has(dismissalKey(state));
  }
}

export function dismiss(state: UpdateState): void {
  if (state.reason === null) return;
  dismissedThisSession.add(dismissalKey(state));
  if (state.reason !== 'version-mismatch') return;
  try {
    localStorage.setItem(DISMISS_KEY, dismissalKey(state));
  } catch {
    /* private mode: the session-scoped copy above still applies */
  }
}
