/**
 * Finding a game's wiki without an index to look it up in.
 *
 * Neither platform will tell us what it hosts. Fandom's discovery API answers
 * 403 to anything that is not a browser and its successors are staff-gated;
 * wiki.gg has no index API at all. What both *will* do is answer `siteinfo` on
 * a wiki that exists and refuse on one that does not — 404 on Fandom, 401 on
 * wiki.gg. So discovery here is guess-and-check: turn "Blue Prince" into the
 * handful of slugs a wiki for it would plausibly live at, ask each one whether
 * it is there, and report what answered.
 *
 * That is a lossy way to find things, and the gaps are not subtle — Zelda's
 * wiki is `zelda.fandom.com`, which no slugification of "Tears of the Kingdom"
 * will ever produce. Hence `hostFromQuery`: paste the address you found in a
 * browser and the guessing is skipped entirely.
 *
 * Probing is user-initiated, never speculative. These are real requests to
 * someone else's servers, and a keystroke is not a reason to make eight of
 * them.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { log, since } from '../log.js';
import type { SourceKind } from './types.js';
import {
  WIKI_PLATFORMS,
  allowedWikiHosts,
  describeWiki,
  isPinned,
  kindForHost,
} from './wikis.js';

export interface WikiCandidate {
  host: string;
  kind: SourceKind;
  sitename: string;
  license: string;
  personalUseOnly: boolean;
  /**
   * Fandom's ex-Gamepedia flag: a positive-only hint that this is a game wiki.
   * Plenty of game wikis predate Gamepedia and report false, so it is shown,
   * never used to filter.
   */
  gamepedia: boolean;
  /** Already allowlisted, so "Add" would be a no-op. */
  allowed: boolean;
  /** Named in WIKI_ALLOWLIST, so the app cannot remove it. */
  pinned: boolean;
}

/** Words that are never part of a wiki's slug. */
const NOISE = new Set(['the', 'a', 'an', 'of', 'and']);

const normalise = (query: string): string[] =>
  query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

/**
 * The slugs a wiki for this game might live at, best guess first.
 *
 * Kept short on purpose: each one costs a request to both platforms, so this
 * is four guesses, not forty.
 */
export function slugCandidates(query: string): string[] {
  const words = normalise(query);
  if (words.length === 0) return [];
  const meaningful = words.filter((word) => !NOISE.has(word));
  const base = meaningful.length > 0 ? meaningful : words;

  const slugs = [
    base.join('-'), // blue-prince
    base.join(''), // animalwell
    words.join('-'), // the-witness, when the article is part of the name
  ];
  return [...new Set(slugs)].filter((slug) => slug.length >= 2 && slug.length <= 60);
}

/**
 * The last resort: the first word on its own.
 *
 * A series title usually hangs off a short wiki — "Zelda: Tears of the Kingdom"
 * lives at `zelda.fandom.com` — but the same guess turns "Blue Prince" into
 * `blue.fandom.com`, which is a real wiki about the colour. So it is only tried
 * when the full name found nothing: as a fallback it rescues the series case,
 * and as a parallel guess it would just add a wrong answer next to the right
 * one.
 */
export function fallbackSlugs(query: string): string[] {
  const base = normalise(query).filter((word) => !NOISE.has(word));
  if (base.length < 2) return [];
  const first = base[0]!;
  return first.length >= 4 ? [first] : [];
}

/**
 * A hostname typed or pasted directly.
 *
 * Accepts a bare host, a full URL, or any page on the wiki, so "the address bar
 * of the tab I am looking at" is a valid answer.
 */
export function hostFromQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!/[.]/.test(trimmed)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/\.$/, '');
    return kindForHost(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Hosts that answered "no".
 *
 * A miss is not cacheable through the HTTP cache — nothing was returned to
 * store — and the same few slugs come up repeatedly as someone retypes a
 * search. Remembering them for an hour keeps a fruitless probe from being
 * repeated on every keystroke of a second attempt.
 */
const misses = new Map<string, number>();
const MISS_TTL_MS = 60 * 60 * 1000;

const recentlyMissed = (host: string): boolean => {
  const at = misses.get(host);
  if (at === undefined) return false;
  if (Date.now() - at > MISS_TTL_MS) {
    misses.delete(host);
    return false;
  }
  return true;
};

/** Test seam. */
export function resetProbeMisses(): void {
  misses.clear();
}

async function probe(cache: Cache, host: string, allowed: Set<string>): Promise<WikiCandidate | null> {
  if (recentlyMissed(host)) return null;
  try {
    const site = await describeWiki(cache, host);
    return {
      host: site.host,
      kind: site.kind,
      sitename: site.sitename,
      license: site.license,
      personalUseOnly: site.personalUseOnly,
      gamepedia: site.gamepedia,
      allowed: allowed.has(site.host),
      pinned: isPinned(site.host),
    };
  } catch {
    // Every failure means the same thing here: there is no wiki to offer. A
    // 404 (Fandom), a 401 (wiki.gg) and a timeout are indistinguishable to
    // someone looking for a game, so none of them is worth surfacing.
    misses.set(host, Date.now());
    return null;
  }
}

export interface DiscoveryResult {
  query: string;
  candidates: WikiCandidate[];
  /** Hosts actually asked, so the UI can say what was tried. */
  probed: string[];
}

const hostsFor = (slugs: string[]): string[] =>
  slugs.flatMap((slug) =>
    WIKI_PLATFORMS.map((kind) => (kind === 'fandom' ? `${slug}.fandom.com` : `${slug}.wiki.gg`)),
  );

export async function discoverWikis(cache: Cache, query: string): Promise<DiscoveryResult> {
  const allowed = new Set(allowedWikiHosts(cache));
  const started = performance.now();
  const probed: string[] = [];

  const round = async (hosts: string[]): Promise<WikiCandidate[]> => {
    probed.push(...hosts);
    const results = await Promise.all(hosts.map((host) => probe(cache, host, allowed)));
    return results.filter((row): row is WikiCandidate => row !== null);
  };

  // A pasted address is an answer, not a guess: probe it and nothing else.
  const direct = hostFromQuery(query);
  let candidates = await round(direct ? [direct] : hostsFor(slugCandidates(query)));

  // Only when the name itself found nothing. See `fallbackSlugs`.
  if (!direct && candidates.length === 0) {
    candidates = await round(hostsFor(fallbackSlugs(query)));
  }

  log.catalog.info(
    { query, probed: probed.length, found: candidates.length, ms: since(started) },
    `wiki discovery "${query}" -> ${candidates.length} of ${probed.length}`,
  );

  return { query, candidates, probed };
}

/** How long a discovery run may take before the UI gets what is ready. */
export const DISCOVERY_TIMEOUT_MS = Math.max(5000, config.searchTimeoutMs);
