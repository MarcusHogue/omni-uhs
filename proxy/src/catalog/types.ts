/** Catalog model shared with the client (spec §7.2a). */

export type SourceKind =
  | 'uhs'
  | 'strategywiki'
  | 'fandom'
  | 'wikigg'
  | 'ifarchive'
  | 'ifdb';

export interface CatalogEntry {
  sourceKind: SourceKind;
  /** Display title from the source. */
  title: string;
  /** Lowercased, articles/punctuation stripped — used for cross-source grouping. */
  normalizedTitle: string;
  /** Source-specific: zip URL, wiki page name, IFDB TUID, archive path. */
  ref: string;
  /**
   * Which wiki this came from, for the multi-wiki sources.
   *
   * Fandom and wiki.gg are hundreds of independent wikis behind one source
   * name, so `ref` (a page title) does not identify anything on its own.
   * Unset for single-host sources, where it would be noise.
   */
  host?: string;
  meta?: { year?: number; platform?: string; complete?: boolean; size?: number; date?: string };
}

export interface CatalogGroup {
  normalizedTitle: string;
  /** Best display title across the sources in this group. */
  title: string;
  entries: CatalogEntry[];
}

export interface SearchResponse {
  query: string;
  groups: CatalogGroup[];
  /** Names of sources that failed; the rest of the response is still valid. */
  warnings: string[];
  sources: SourceKind[];
  /**
   * Sources that refused the *server* with a bot challenge. The browser may
   * still be able to reach them itself, so the client uses this to decide
   * whether a direct, client-side retry is worth attempting.
   */
  challenged: SourceKind[];
}
