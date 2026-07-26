/**
 * Putting a StrategyWiki game back into reading order.
 *
 * The fixture is the real thing: `Chrono Trigger/Walkthrough` as the wiki
 * serves it, four paragraphs of prose ending in a `{{Footer Nav}}`. That shape
 * is the whole finding — the page named as the walkthrough's parent is not an
 * index at all, and every attempt to read an ordering out of *it* comes back
 * with one link. The order is in the chain the chapters carry.
 */

import { describe, expect, it } from 'vitest';

import { footerNext, orderWalkthrough } from '../../src/parser/wikitext/strategywiki.js';

const GAME = 'Chrono Trigger';

/** The opening of the real page, trimmed to the parts that carry structure. */
const WALKTHROUGH = `{{Header Nav|game=Chrono Trigger}}
Welcome to the walkthrough of Chrono Trigger. This game has three versions, however all three follow the same plot. Extra zones for the Nintendo DS are covered on their respective pages (please see the [[Chrono Trigger/Table of Contents|table of contents]]).

Sections of the walkthrough are split up into chapters as defined by the developers (note that in the [[../Table of Contents|Table of Contents]], the remake names of each chapter are in '''bold''').

{{Footer Nav|game=Chrono Trigger|nextpage=The Millennial Fair}}`;

const chapter = (previous: string, next?: string): string =>
  `{{Header Nav|game=Chrono Trigger}}\nProse.\n{{Footer Nav|game=Chrono Trigger|prevpage=${previous}${
    next === undefined ? '' : `|nextpage=${next}`
  }}}`;

const page = (title: string, wikitext: string): { title: string; wikitext: string } => ({
  title,
  wikitext,
});

describe('footerNext', () => {
  it('reads the next chapter off the foot of the page', () => {
    expect(footerNext(WALKTHROUGH, GAME)).toBe('Chrono Trigger/The Millennial Fair');
  });

  it('accepts a value that already names the game', () => {
    // Both spellings are in use across the wiki, and both mean the same page.
    const both = '{{Footer Nav|game=Chrono Trigger|nextpage=Chrono Trigger/Manoria Cathedral}}';
    expect(footerNext(both, GAME)).toBe('Chrono Trigger/Manoria Cathedral');
    expect(footerNext('{{Footer Nav|game=Chrono Trigger|nextpage=/Guardia Forest}}', GAME)).toBe(
      'Chrono Trigger/Guardia Forest',
    );
  });

  it('says nothing when the page is the last one, or carries no nav at all', () => {
    expect(footerNext('{{Footer Nav|game=Chrono Trigger|prevpage=Black Omen}}', GAME)).toBeNull();
    expect(footerNext('{{Footer Nav|game=Chrono Trigger|nextpage=}}', GAME)).toBeNull();
    expect(footerNext('Just prose.', GAME)).toBeNull();
  });

  it('is not fooled by a template inside a parameter', () => {
    // A flat `[^{}]*` stops at the inner `}}` and never reaches `nextpage`,
    // which loses exactly one chapter and looks like the chain simply ended.
    const nested =
      '{{Footer Nav|game=Chrono Trigger|prevname={{nihongo|Zeal}}|nextpage=Ocean Palace}}';
    expect(footerNext(nested, GAME)).toBe('Chrono Trigger/Ocean Palace');
  });
});

describe('orderWalkthrough', () => {
  it('walks the chain, and puts the reference pages after it', () => {
    // Deliberately handed over alphabetically, which is what `list=allpages`
    // returns and what the download used to store: "Beyond the Ruins" — the
    // penultimate chapter — first, and the opening chapter last.
    const pages = [
      page('Chrono Trigger', 'The game.'),
      page('Chrono Trigger/Bestiary', 'Every enemy.'),
      page('Chrono Trigger/Guardia Forest', chapter('The Millennial Fair')),
      page('Chrono Trigger/The Millennial Fair', chapter('Walkthrough', 'Guardia Forest')),
      page('Chrono Trigger/Walkthrough', WALKTHROUGH),
    ];

    const { ordered, notes } = orderWalkthrough(pages, GAME);
    expect(ordered.map((p) => p.title)).toEqual([
      'Chrono Trigger',
      'Chrono Trigger/Walkthrough',
      'Chrono Trigger/The Millennial Fair',
      'Chrono Trigger/Guardia Forest',
      'Chrono Trigger/Bestiary',
    ]);
    expect(notes).toEqual([]);
  });

  it('keeps the appendices, after the walkthrough', () => {
    // Asked for explicitly: a StrategyWiki game is its walkthrough *and* its
    // reference pages, and dropping everything outside the chain would lose
    // half of what was downloaded.
    const pages = [
      page('Chrono Trigger/Appendices', 'Endings, sidequests.'),
      page('Chrono Trigger/Items', 'Every item.'),
      page('Chrono Trigger/The Millennial Fair', chapter('Walkthrough')),
      page('Chrono Trigger/Walkthrough', WALKTHROUGH),
    ];

    expect(orderWalkthrough(pages, GAME).ordered.map((p) => p.title)).toEqual([
      'Chrono Trigger/Walkthrough',
      'Chrono Trigger/The Millennial Fair',
      'Chrono Trigger/Appendices',
      'Chrono Trigger/Items',
    ]);
  });

  it('stops rather than looping when a chain points back at itself', () => {
    const pages = [
      page('Chrono Trigger/Walkthrough', WALKTHROUGH),
      page('Chrono Trigger/The Millennial Fair', chapter('Walkthrough', 'Walkthrough')),
    ];
    expect(orderWalkthrough(pages, GAME).ordered.map((p) => p.title)).toEqual([
      'Chrono Trigger/Walkthrough',
      'Chrono Trigger/The Millennial Fair',
    ]);
  });

  it('falls back to the links on a Walkthrough page that is an index', () => {
    // StrategyWiki has thousands of games and the chain was verified on one.
    // A game that writes its Walkthrough page as a list of chapters still has
    // an order, and it is the order the list is written in.
    const index = `{{Header Nav|game=Quest}}
# [[Quest/Chapter Three]]
# [[Quest/Chapter One]]`;
    const pages = [
      page('Quest/Chapter One', 'Prose.'),
      page('Quest/Chapter Three', 'Prose.'),
      page('Quest/Walkthrough', index),
    ];

    const { ordered, notes } = orderWalkthrough(pages, 'Quest');
    expect(ordered.map((p) => p.title)).toEqual([
      'Quest/Walkthrough',
      'Quest/Chapter Three',
      'Quest/Chapter One',
    ]);
    expect(notes).toEqual([]);
  });

  it('says so when the wiki gives no order at all', () => {
    // Alphabetical is still a download; presenting it as reading order is the
    // thing to avoid, so the note goes on the Library row.
    const pages = [page('Quest/Bosses', 'Prose.'), page('Quest/Areas', 'Prose.')];
    const { ordered, notes } = orderWalkthrough(pages, 'Quest');
    expect(ordered.map((p) => p.title)).toEqual(['Quest/Areas', 'Quest/Bosses']);
    expect(notes[0]).toMatch(/alphabetical order/);
  });
});
