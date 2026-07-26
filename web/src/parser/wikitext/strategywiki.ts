/**
 * Putting a StrategyWiki game back into reading order.
 *
 * StrategyWiki is the only source here whose order is *load-bearing*. A Fandom
 * wiki is a reference work — its pages are alphabetical and nothing is lost by
 * that — but a walkthrough sorted alphabetically is not a walkthrough, and until
 * now that is exactly what a download produced: `list=allpages` in title order,
 * so Chrono Trigger opened on "Beyond the Ruins" and ended on "The Millennial
 * Fair", which is the second-to-last chapter and the first.
 *
 * The order is not in the API. `prop=links` returns links alphabetically, and
 * `Chrono Trigger/Walkthrough` turns out not to be an index at all — it is four
 * paragraphs of prose that end:
 *
 *     {{Footer Nav|game=Chrono Trigger|nextpage=The Millennial Fair}}
 *
 * That is the structure: every chapter page carries a `Footer Nav` naming the
 * one after it, so the walkthrough is a linked list and the order is recovered
 * by walking it. Nothing extra is fetched to do so — the download already has
 * every page's wikitext, so the chain is followed in memory.
 *
 * Two fallbacks, because StrategyWiki has thousands of games and this was
 * verified against one. A game whose Walkthrough page *is* an index falls back
 * to the links on it in document order; a game with neither falls back to
 * alphabetical, and says so in a parser note rather than presenting a shuffled
 * walkthrough as if it were ordered.
 */

import { normalizePageTitle, orderedLinks } from './index';
import { splitParams } from './images';

/** `{{Footer Nav|game=Chrono Trigger|prevpage=…|nextpage=…}}`. */
const FOOTER_NAV = /\{\{\s*footer[ _]nav\s*[|}]/i;

/**
 * The inner text of the first `{{Footer Nav}}` on a page.
 *
 * Scanned with a depth counter rather than matched with `[^{}]*`, because a
 * parameter can hold a template of its own and a flat pattern would stop at its
 * closing braces — leaving a truncated parameter list that happens to still
 * parse, which is the kind of wrong that shows up as one missing chapter.
 */
function footerNavBody(wikitext: string): string | null {
  const start = FOOTER_NAV.exec(wikitext);
  if (!start) return null;

  let depth = 0;
  for (let i = start.index; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
      depth++;
      i++;
    } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      if (depth === 0) return wikitext.slice(start.index + 2, i);
      i++;
    }
  }
  return null;
}

/**
 * The page this one says comes next, as a full title.
 *
 * `nextpage` is written relative to the game — `nextpage=The Millennial Fair`
 * on a Chrono Trigger page means `Chrono Trigger/The Millennial Fair` — but not
 * always: deeper trees write the sub-path, and some pages write the whole title.
 * All three resolve to the same place here.
 */
export function footerNext(wikitext: string, game: string): string | null {
  const body = footerNavBody(wikitext);
  if (body === null) return null;

  for (const part of splitParams(body).slice(1)) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim().toLowerCase() !== 'nextpage') continue;

    const value = part.slice(equals + 1).trim().replace(/^\/+/, '');
    if (!value) return null;
    const prefix = `${game}/`;
    return normalizePageTitle(
      value.toLowerCase().startsWith(prefix.toLowerCase()) ? value : prefix + value,
    );
  }
  return null;
}

export interface OrderedPages<T> {
  ordered: T[];
  /** Parser notes: why the order is what it is, when it is not the game's own. */
  notes: string[];
}

interface Page {
  title: string;
  wikitext: string;
}

/**
 * Every fetched page, walkthrough first and in the order the game prescribes.
 *
 * Nothing is dropped. Pages outside the chain — the appendices, the bestiary,
 * the item lists — follow it alphabetically, because they are reference material
 * with no reading order of their own and leaving them out would lose half of
 * what a StrategyWiki game is.
 */
export function orderWalkthrough<T extends Page>(pages: T[], game: string): OrderedPages<T> {
  const byTitle = new Map(pages.map((page) => [normalizePageTitle(page.title), page]));
  const notes: string[] = [];

  const ordered: T[] = [];
  const taken = new Set<T>();
  const take = (page: T | undefined): boolean => {
    if (!page || taken.has(page)) return false;
    taken.add(page);
    ordered.push(page);
    return true;
  };

  // The game's own page is the title page whatever else happens.
  take(byTitle.get(normalizePageTitle(game)));

  const start = byTitle.get(normalizePageTitle(`${game}/Walkthrough`));
  if (start) {
    take(start);
    // Bounded by the page count: a `nextpage` that points back up the chain
    // would otherwise loop forever, and `take` returning false catches it.
    let current: T | undefined = start;
    while (current) {
      const next = footerNext(current.wikitext, game);
      current = next ? byTitle.get(next) : undefined;
      if (current && !take(current)) break;
    }

    // A Walkthrough page with no chain leaving it is an index on some games.
    if (ordered.length <= 2) {
      for (const link of orderedLinks(start.wikitext)) take(byTitle.get(link.title));
    }
  }

  if (ordered.length <= 2) {
    notes.push(
      `${game}: StrategyWiki does not say what order these pages read in — no walkthrough chain was found, so they are in alphabetical order.`,
    );
  }

  const rest = pages
    .filter((page) => !taken.has(page))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { ordered: [...ordered, ...rest], notes };
}
