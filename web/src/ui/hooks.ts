import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listDocuments, type StoredDocument } from '../storage/db';

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
