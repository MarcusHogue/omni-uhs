/**
 * Typed client for the proxy. The only module in the app that knows the
 * network exists — everything downstream of a completed download works from
 * IndexedDB alone.
 */

import type { SourceKind } from '../parser/ast';

export interface CatalogEntry {
  sourceKind: SourceKind;
  title: string;
  normalizedTitle: string;
  ref: string;
  meta?: { year?: number; platform?: string; complete?: boolean; size?: number; date?: string };
}

export interface CatalogGroup {
  normalizedTitle: string;
  title: string;
  entries: CatalogEntry[];
}

export interface SearchResponse {
  query: string;
  groups: CatalogGroup[];
  warnings: string[];
  sources: SourceKind[];
}

export interface ListResponse {
  source: string;
  entries: CatalogEntry[];
  warnings: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when the failure is "you are offline", not "the server said no". */
export function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status === 0);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the hint proxy — you may be offline.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  search(query: string, sources?: SourceKind[], signal?: AbortSignal): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (sources && sources.length > 0) params.set('sources', sources.join(','));
    return getJson<SearchResponse>(`/api/catalog/search?${params}`, signal);
  },

  list(source: string, prefix?: string, signal?: AbortSignal): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    return getJson<ListResponse>(`/api/catalog/${source}/list?${params}`, signal);
  },

  /** The zip containing a .uhs file. */
  async uhsFile(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(`/api/uhs/file?url=${encodeURIComponent(url)}`, { signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `Download failed (${response.status})`, response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  },

  async ifArchiveFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(`/api/ifarchive/${path.replace(/^\/+/, '')}`, { signal });
    if (!response.ok) throw new ApiError(`Download failed (${response.status})`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  },

  strategyWiki<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return getJson<T>(`/api/strategywiki?${new URLSearchParams(params)}`, signal);
  },

  license(): Promise<{ license: string; url: string; personalUseOnly: boolean }> {
    return getJson('/api/strategywiki/license');
  },
};
