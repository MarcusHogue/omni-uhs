/**
 * Which pages of a game wiki are worth reading.
 *
 * A wiki *is* a game, so downloading one should hand you the game, not a list
 * of pages to collect by hand. That moves the question here: out of the hundreds
 * of pages on a game wiki, which ones carry guidance?
 *
 * The previous answer — ask ten fixed category names — was measured against
 * eight real game wikis and only worked on one of them:
 *
 *     blue-prince 50   animalwell 10   tunic 9   fez 4   braid 2
 *     obradinn 0       outerwilds 0    hollowknight 0 (a 557-page wiki)
 *
 * Category *names* are game-specific and endlessly varied — `Bosses (Hollow
 * Knight)`, `Locations on Timber Hearth`, `Secret rabbits`, `Mechanisms` — so
 * matching them exactly is hopeless. The words inside them are a fine signal;
 * the exact string never was.
 *
 * So four signals are gathered, weighted, and *then* truncated:
 *
 * 1. **The main page's own links.** Every game wiki has a hand-curated hub, and
 *    what its editors chose to link is the best recommendation available.
 * 2. **Categories the wiki actually has**, scored on their names.
 * 3. **Search**, always — both for the game's name and for guidance vocabulary,
 *    letting MediaWiki's own relevance ranking do work no keyword list can.
 * 4. **Every page**, as a floor. `allpages` is one or two requests even for a
 *    784-page wiki and guarantees a non-empty answer on a wiki that files and
 *    links nothing.
 *
 * Ranking before truncating matters as much as the signals. The old code filled
 * a set until it hit the cap, so the first sixty titles won *by arrival order*
 * and categories always beat search regardless of quality.
 *
 * Precision is not the goal. Anything that slips through is ranked low by the
 * reader rather than dropped; the job here is a superset small enough to fetch
 * politely.
 */

import { config } from '../config.js';
import type { Cache } from '../cache/index.js';
import { log } from '../log.js';
import { apiUrl, type WikiTarget } from './mediawiki.js';

/**
 * Words that suggest a category holds guidance.
 *
 * Matched anywhere in the name, which is the whole point: `Bosses (Hollow
 * Knight)` and `Secret rabbits` both hit, and neither would ever have appeared
 * in a list of exact names.
 */
const GUIDANCE_WORDS = [
  'walkthrough',
  'puzzle',
  'secret',
  'ending',
  'boss',
  'quest',
  'guide',
  'collectible',
  // Stems, not words: "strategies" does not contain "strategy", and a category
  // called "Boss strategies" is exactly the kind this exists to catch.
  'strateg',
  'solution',
  'achievement',
  'mechanic',
  'location',
  'item',
  'chapter',
  'mission',
  'level',
];

/**
 * Categories that are filing, not content.
 *
 * Every game wiki has these and they are enormous: `X HK Screenshots` has 1265
 * members, `Non-free files` 592. They are also the categories most likely to
 * match on size alone, so they are rejected by name first.
 */
const CATEGORY_NOISE =
  /(screenshot|image|file|media|audio|video|sprite|texture|artwork|render|icon|stub|template|disambiguat|delet|maintenance|cleanup|user|forum|blog|policy|copyright|licens|navigation|browse|wiki$|pages? with|articles? (with|needing)|candidates)/i;

/** A category with more members than this is a bucket, not a curated list. */
const CATEGORY_BUCKET = 200;

/** How many discovered categories to actually fetch the members of. */
const CATEGORY_FETCH = 8;

/**
 * Titles that are never guidance, whatever else recommends them.
 *
 * Drawn from what actually leaked through on the five test wikis: patch-note
 * pages (`Updates (Hollow Knight)`), media indexes (`Videos`), ID tables
 * (`Gore IDs`, `Armor/id`), and the `Wiki/…` subpages a main page transcludes
 * itself from, which arrive with a high main-page weight and contain nothing.
 */
const TITLE_NOISE = new RegExp(
  [
    /^\d+\.\d/, // 1.4.0.1 — a patch note
    /^(versions?|updates?|patch(es)?|changelogs?|news|videos?|images?|gallery)\b/,
    /^(list of |bestiary|soundtrack|credits|cut content|unused|category:)/,
    /^gore ids$/,
    /\/(id|ids|list|dr)$/,
    / ?wiki\/./, // Animal Well Wiki/Top section
    /\(disambiguation\)/,
  ]
    .map((part) => part.source)
    .join('|'),
  'i',
);

/** Below this many bytes a page is a stub — Terraria's median page is 134. */
const MIN_PAGE_BYTES = 200;

/** Never fetch more than this from one wiki, however much it offers. */
const MAX_PAGES = Math.max(1, Number(process.env['WIKI_MAX_PAGES']) || 60);

/** How many `allpages` requests to spend before accepting a partial sweep. */
const ENUMERATE_REQUESTS = 20;

/** What each signal is worth before rank decay. */
const WEIGHT = {
  mainPage: 3,
  category: 2,
  guidanceSearch: 1.5,
  nameSearch: 1,
  enumerated: 0.5,
} as const;

interface ListPayload {
  query?: {
    categorymembers?: { title?: string; ns?: number }[];
    search?: { title?: string; ns?: number }[];
    allcategories?: { category?: string; size?: number }[];
    // Both `generator=links` and `generator=allpages` answer here.
    pages?: { title?: string; ns?: number; length?: number }[];
    general?: { mainpage?: string };
  };
  continue?: Record<string, string>;
}

const mainNamespace = (row: { ns?: number }): boolean => row.ns === undefined || row.ns === 0;

const titlesFrom = (payload: ListPayload): string[] =>
  [
    ...(payload.query?.categorymembers ?? []),
    ...(payload.query?.search ?? []),
    // `generator=` results land under `pages`, not under the list name.
    ...(payload.query?.pages ?? []),
  ]
    .filter(mainNamespace)
    .map((row) => row.title)
    .filter((title): title is string => Boolean(title));

async function query(
  cache: Cache,
  target: WikiTarget,
  params: Record<string, string>,
): Promise<ListPayload> {
  const entry = await cache.fetch({
    url: apiUrl(target.api, params),
    ttl: config.ttl.index,
    accept: 'application/json',
    ...(target.allowlist ? { allowlist: target.allowlist } : {}),
  });
  return JSON.parse(await cache.readText(entry)) as ListPayload;
}

/** Titles only, and never throwing: one dead signal must not lose the others. */
async function titles(
  cache: Cache,
  target: WikiTarget,
  params: Record<string, string>,
): Promise<string[]> {
  try {
    return titlesFrom(await query(cache, target, params));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- the signals */

/**
 * How much a category name suggests guidance. 0 means "do not bother".
 *
 * Size is a signal in both directions: a category with two members is usually
 * an accident, and one with a thousand is a bucket the wiki files images into.
 */
export function scoreCategory(name: string, members: number): number {
  if (CATEGORY_NOISE.test(name)) return 0;
  if (members > CATEGORY_BUCKET || members < 2) return 0;
  const lower = name.toLowerCase();
  const hits = GUIDANCE_WORDS.filter((word) => lower.includes(word)).length;
  if (hits === 0) return 0;
  // Two guidance words are better than one ("Boss strategies"), and a tight
  // category is better than a sprawling one.
  return hits + (members <= 60 ? 0.5 : 0);
}

/** Pages a wiki's own front page links to — its editors' recommendation. */
async function fromMainPage(cache: Cache, target: WikiTarget): Promise<string[]> {
  const info = await query(cache, target, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general',
  }).catch(() => null);
  const mainpage = info?.query?.general?.mainpage;
  if (!mainpage) return [];
  return titles(cache, target, {
    action: 'query',
    generator: 'links',
    titles: mainpage,
    gpllimit: '100',
    gplnamespace: '0',
  });
}

/** The categories this wiki actually has, best-scoring first. */
async function guidanceCategories(cache: Cache, target: WikiTarget): Promise<string[]> {
  const payload = await query(cache, target, {
    action: 'query',
    list: 'allcategories',
    acmin: '2',
    aclimit: '500',
    acprop: 'size',
  }).catch(() => null);

  return (payload?.query?.allcategories ?? [])
    .map((row) => ({ name: row.category ?? '', score: scoreCategory(row.category ?? '', row.size ?? 0) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, CATEGORY_FETCH)
    .map((row) => row.name);
}

/**
 * Every article, with its size.
 *
 * One request for a 252-page wiki, two for 784, fifteen for Terraria's 7500 —
 * cheap enough to be the floor under everything else, and `length` is the only
 * quality signal available without fetching content.
 */
async function enumeratePages(
  cache: Cache,
  target: WikiTarget,
): Promise<{ pages: Map<string, number>; truncated: boolean }> {
  const pages = new Map<string, number>();
  let cont: Record<string, string> = {};

  for (let request = 0; request < ENUMERATE_REQUESTS; request++) {
    let payload: ListPayload;
    try {
      payload = await query(cache, target, {
        action: 'query',
        generator: 'allpages',
        gapnamespace: '0',
        gaplimit: '500',
        prop: 'info',
        ...cont,
      });
    } catch {
      return { pages, truncated: true };
    }
    for (const page of payload.query?.pages ?? []) {
      if (page.title && mainNamespace(page)) pages.set(page.title, page.length ?? 0);
    }
    const next = payload.continue;
    if (!next) return { pages, truncated: false };
    cont = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'continue'));
  }
  return { pages, truncated: true };
}

/* -------------------------------------------------------------- the gather */

export interface PageCandidates {
  titles: string[];
  /** How many titles each signal contributed, so a thin result can be explained. */
  sources: Record<string, number>;
  /** True when the wiki was too big to enumerate fully. */
  truncated: boolean;
  /** How many distinct pages were considered before truncating to MAX_PAGES. */
  considered: number;
}

export async function gatherPages(
  cache: Cache,
  target: WikiTarget,
  game: string,
): Promise<PageCandidates> {
  const weights = new Map<string, number>();
  const sources: Record<string, number> = {};

  /** Rank decay: the tenth hit from a signal is worth less than the first. */
  const contribute = (from: string, weight: number, found: string[]): void => {
    let added = 0;
    found.forEach((title, index) => {
      if (TITLE_NOISE.test(title)) return;
      const value = weight / (1 + index / 10);
      const current = weights.get(title);
      if (current === undefined) added += 1;
      weights.set(title, (current ?? 0) + value);
    });
    if (added > 0) sources[from] = (sources[from] ?? 0) + added;
  };

  const [mainPage, categories, { pages: enumerated, truncated }] = await Promise.all([
    fromMainPage(cache, target),
    guidanceCategories(cache, target),
    enumeratePages(cache, target),
  ]);

  contribute('main page', WEIGHT.mainPage, mainPage);

  const members = await Promise.all(
    categories.map((category) =>
      titles(cache, target, {
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmlimit: '100',
        cmnamespace: '0',
      }),
    ),
  );
  members.forEach((found) => contribute('categories', WEIGHT.category, found));

  // Both searches always run. The old code gated search on the categories
  // coming up short, which meant the one wiki where categories worked well was
  // the one wiki that never got a second opinion.
  const [byName, byGuidance] = await Promise.all([
    titles(cache, target, {
      action: 'query',
      list: 'search',
      srsearch: game,
      srlimit: '30',
      srnamespace: '0',
    }),
    titles(cache, target, {
      action: 'query',
      list: 'search',
      srsearch: 'puzzle OR solution OR walkthrough OR secret OR ending OR "how to"',
      srlimit: '30',
      srnamespace: '0',
    }),
  ]);
  contribute('search', WEIGHT.nameSearch, byName);
  contribute('guidance search', WEIGHT.guidanceSearch, byGuidance);

  // The floor, and the source of the length bonus below.
  contribute(
    'all pages',
    WEIGHT.enumerated,
    [...enumerated.entries()]
      .filter(([, length]) => length >= MIN_PAGE_BYTES)
      .sort((a, b) => b[1] - a[1])
      .map(([title]) => title),
  );

  // Substance, as a modest tiebreak rather than a signal of its own: a long
  // page is more likely to say something, and a stub never is.
  for (const [title, weight] of weights) {
    const length = enumerated.get(title);
    if (length !== undefined && length < MIN_PAGE_BYTES) weights.delete(title);
    else weights.set(title, weight + Math.log10(Math.max(length ?? 500, 100)) / 4);
  }

  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([title]) => title);

  log.catalog.info(
    { game, considered: ranked.length, taken: Math.min(ranked.length, MAX_PAGES), sources, truncated },
    `page selection for ${game}: ${Math.min(ranked.length, MAX_PAGES)} of ${ranked.length}`,
  );

  return {
    titles: ranked.slice(0, MAX_PAGES),
    sources,
    truncated,
    considered: ranked.length,
  };
}
