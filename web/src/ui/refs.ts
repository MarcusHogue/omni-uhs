/**
 * Turning a catalog entry into the URL a stored document records.
 *
 * A `CatalogEntry.ref` is whatever its source uses to name a thing — a download
 * URL for UHS, an archive path for the IF Archive, a page title for a wiki — but
 * a `StoredDocument` always records a `sourceUrl`. Matching one against the
 * other is what lights the "Available offline" pill, so the two forms have to be
 * built the same way in Search and in Browse.
 */

import type { CatalogEntry } from '../api/client';

/**
 * A wiki page's URL.
 *
 * Must match the `pageUrl` `parseWikiWalkthrough` builds from its `baseUrl`, or
 * the pill lies. `/wiki/` is hard-coded rather than read from the wiki's own
 * `articlepath`: both platforms report `/wiki/$1`, the allowlist is keyed on
 * hostname so a Fandom language wiki (`/de/wiki/$1`) cannot be reached anyway,
 * and a value that had to be fetched could not be used from a render.
 */
export function wikiPageUrl(host: string, ref: string): string {
  // A wiki entry is the whole game, and its `ref` is the host itself. The
  // document records the wiki's article root, so that is what has to match.
  if (ref === host) return `https://${host}/wiki/`;
  return `https://${host}/wiki/${encodeURIComponent(ref.replace(/ /g, '_'))}`;
}

export function refUrl(entry: CatalogEntry): string {
  if (entry.sourceKind === 'ifarchive') {
    return `https://ifarchive.org/${entry.ref.replace(/^\/+/, '')}`;
  }
  if (entry.sourceKind === 'strategywiki') {
    return `https://strategywiki.org/wiki/${encodeURIComponent(
      entry.ref.split('/')[0]!.replace(/ /g, '_'),
    )}`;
  }
  if (entry.host) return wikiPageUrl(entry.host, entry.ref);
  return entry.ref;
}
