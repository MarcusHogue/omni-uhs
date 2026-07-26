import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { listDocuments, type StoredDocument } from '../storage/db';
import {
  applyWaitingUpdate,
  checkNow,
  dismiss as dismissUpdate,
  dismissalKey,
  getUpdateState,
  isDismissed,
  subscribe,
  type UpdateState,
} from './update';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Whether the header and tab bar should be on screen.
 *
 * Scrolling down hides them, scrolling up brings them back, and the top of the
 * page always shows them. The 8px threshold stops the chrome flickering on the
 * small scroll jitter a thumb produces while reading.
 */
export function useChromeVisibility(threshold = 8): boolean {
  const [visible, setVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    let frame = 0;

    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        const delta = y - lastY.current;
        if (Math.abs(delta) < threshold) return;
        // Near the top, or on any upward movement, the chrome comes back.
        setVisible(y < 64 || delta < 0);
        lastY.current = y;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threshold]);

  // A route change should never leave the chrome stranded off screen.
  const { pathname } = useLocation();
  useEffect(() => {
    setVisible(true);
  }, [pathname]);

  return visible;
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface LibraryState {
  documents: StoredDocument[];
  loading: boolean;
  reload: () => void;
}

/** The library, straight from IndexedDB. Never touches the network. */
export function useLibrary(): LibraryState {
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listDocuments().then((all) => {
      if (cancelled) return;
      setDocuments(all);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { documents, loading, reload };
}

/** Which refs are already downloaded, so search results can say so inline. */
export function useOfflineRefs(documents: StoredDocument[]): Set<string> {
  return useMemo(() => new Set(documents.map((d) => d.sourceUrl)), [documents]);
}

/** Latest-wins async calls: an older response must never overwrite a newer one. */
export function useLatest(): (fn: (signal: AbortSignal) => Promise<void>) => void {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return useCallback((fn) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    void fn(next.signal).catch((error: unknown) => {
      if ((error as Error).name !== 'AbortError') throw error;
    });
  }, []);
}

/**
 * Whether a newer build is available, and whether the user has waved it away.
 *
 * The banner honours the dismissal; Settings deliberately does not — "easy to
 * ignore in the way, impossible to miss when you go looking" is the whole
 * design of this feature.
 */
export function useAppUpdate(): {
  state: UpdateState;
  dismissed: boolean;
  dismiss: () => void;
  apply: () => void;
  check: () => Promise<void>;
} {
  const [state, setState] = useState<UpdateState>(() => getUpdateState());
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => subscribe(setState), []);

  return {
    state,
    dismissed: dismissedKey === dismissalKey(state) || isDismissed(state),
    dismiss: () => {
      dismissUpdate(state);
      setDismissedKey(dismissalKey(state));
    },
    apply: () => void applyWaitingUpdate(),
    check: async () => {
      setState(await checkNow());
    },
  };
}
