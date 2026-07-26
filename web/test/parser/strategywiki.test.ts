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

import { walk } from '../../src/parser/ast.js';
import { parseWikiWalkthrough } from '../../src/parser/wikitext/index.js';
import {
  footerNext,
  orderWalkthrough,
  parseTableOfContents,
} from '../../src/parser/wikitext/strategywiki.js';

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

/**
 * The real `Chrono Trigger/Table of Contents`, trimmed to four chapters and
 * three appendices (strategywiki.org, CC-BY-SA-4.0). Everything structural is
 * kept verbatim: the `{{col}}` layout, `{{h2|…}}` headings both bare and
 * linked, and the `{{listcol|list=…}}` wrapper around the numbered chapters.
 */
const CONTENTS = `<noinclude>{{Header Nav|game=Chrono Trigger}}</noinclude>
{{col|4|begin}}
{{h2|[[Chrono Trigger/Gameplay|Gameplay]]}}
* [[Chrono Trigger/Controls|Controls]]
* [[Chrono Trigger/Characters|Characters]]
[[File:Chrono Trigger logo.png|200px|Chrono Trigger logo]]
{{col|4}}
{{h2|Appendices}}
* [[Chrono Trigger/Chronology|Chronology]]
* [[Chrono Trigger/Inns|Inns]]
* [[Chrono Trigger/Maps|Maps]]
{{col|4|end}}
{{h2|[[Chrono Trigger/Walkthrough|Walkthrough]]|1}}
{{listcol|list=
# [[Chrono Trigger/The Millennial Fair|The Millennial Fair]] (1000 A.D. first time)
# [[Chrono Trigger/The Queen Returns|The Queen Returns]] (600 A.D. first time)
# [[Chrono Trigger/Beyond the Ruins|Beyond the Ruins]] (2300 A.D. first time)
# [[Chrono Trigger/Endings|Endings]]
}}`;

describe('parseTableOfContents', () => {
  it('reads the whole guide, in the order and the sections the wiki gives', () => {
    expect(parseTableOfContents(CONTENTS, GAME)).toEqual([
      {
        title: 'Gameplay',
        pages: ['Chrono Trigger/Gameplay', 'Chrono Trigger/Controls', 'Chrono Trigger/Characters'],
      },
      {
        title: 'Appendices',
        pages: ['Chrono Trigger/Chronology', 'Chrono Trigger/Inns', 'Chrono Trigger/Maps'],
      },
      {
        title: 'Walkthrough',
        pages: [
          'Chrono Trigger/Walkthrough',
          'Chrono Trigger/The Millennial Fair',
          'Chrono Trigger/The Queen Returns',
          'Chrono Trigger/Beyond the Ruins',
          'Chrono Trigger/Endings',
        ],
      },
    ]);
  });

  it('keeps the chapters that live inside {{listcol}}', () => {
    // The failure this guards is total and silent. `{{listcol|list=…}}` is
    // multi-line with no recognised body parameter, so the ordinary link scan
    // strips it — and with it every chapter of the walkthrough, leaving a
    // Table of Contents that appears to list only the appendices.
    const walkthrough = parseTableOfContents(CONTENTS, GAME).find(
      (section) => section.title === 'Walkthrough',
    );
    expect(walkthrough?.pages).toContain('Chrono Trigger/The Millennial Fair');
    expect(walkthrough?.pages).toHaveLength(5);
  });

  it('takes a heading whose parameter is itself a link', () => {
    // `{{h2|[[Portal/Gameplay|Gameplay]]}}` names the section *and* names one of
    // its pages, so the label and the target both have to be read.
    const [gameplay] = parseTableOfContents(CONTENTS, GAME);
    expect(gameplay?.title).toBe('Gameplay');
    expect(gameplay?.pages[0]).toBe('Chrono Trigger/Gameplay');
  });

  it('leaves out pictures, itself, and pages belonging to other games', () => {
    const pages = parseTableOfContents(
      `${CONTENTS}\n* [[Chrono Cross]]\n* [[Chrono Trigger/Table of Contents|ToC]]`,
      GAME,
    ).flatMap((section) => section.pages);
    expect(pages).not.toContain('Chrono Cross');
    expect(pages.some((page) => page.includes('Table of Contents'))).toBe(false);
    expect(pages.some((page) => page.includes('.png'))).toBe(false);
  });

  it('follows a companion guide the index names in a {{subtoc}}', () => {
    // Portal's contents lists fourteen `Portal: Still Alive/…` pages, and
    // `list=allpages&apprefix=Portal/` cannot see one of them.
    const sections = parseTableOfContents(
      '{{subtoc|Portal: Still Alive}}\n{{h2|Challenge Maps}}\n# [[Portal: Still Alive/Challenge Map 1|Map 1]]',
      'Portal',
    );
    expect(sections[0]?.pages).toEqual(['Portal: Still Alive/Challenge Map 1']);
  });

  it('does not swallow a different game that happens to share the prefix', () => {
    // The first attempt guessed at companions from the title, and any rule
    // loose enough to accept "Portal: Still Alive" from "Portal" also accepts
    // "Portal 2" — a separate game with its own guide, pulled into this
    // download. The wiki names its companions, so there is nothing to infer.
    const sections = parseTableOfContents(
      `{{subtoc|Portal: Still Alive}}
{{h2|See also}}
* [[Portal 2/Chapter 1|Portal 2]]
* [[Portal: Still Alive/Achievements|Achievements]]`,
      'Portal',
    );
    expect(sections.flatMap((section) => section.pages)).toEqual([
      'Portal: Still Alive/Achievements',
    ]);
  });

  it('says nothing about a page that is not an index', () => {
    expect(parseTableOfContents('Just prose about the game.', GAME)).toEqual([]);
  });
});

describe('a game grouped by its Table of Contents', () => {
  const pages = [
    'Chrono Trigger/Walkthrough',
    'Chrono Trigger/The Millennial Fair',
    'Chrono Trigger/Beyond the Ruins',
    'Chrono Trigger/Inns',
    'Chrono Trigger/Controls',
    'Chrono Trigger/Bestiary',
  ].map((title) => ({ title, wikitext: `Prose for ${title}.`, revision: '1' }));

  const parsed = (): ReturnType<typeof parseWikiWalkthrough> =>
    parseWikiWalkthrough(pages, {
      kind: 'strategywiki',
      gameTitle: GAME,
      baseUrl: 'https://strategywiki.org/wiki/',
      license: 'CC-BY-SA-4.0',
      personalUseOnly: false,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      reveal: 'as-written',
      groups: parseTableOfContents(CONTENTS, GAME),
    });

  it('opens on the sections rather than a flat scroll of pages', () => {
    const top = parsed().document.root.children;
    expect(top.map((node) => node.label)).toEqual([
      'Gameplay',
      'Appendices',
      'Walkthrough',
      // Listed by neither the index nor a group: kept, and last, because a page
      // must never be lost by being left out of an index.
      'Bestiary',
    ]);
  });

  it('puts the walkthrough chapters in play order under Walkthrough', () => {
    // Handed over alphabetically, which is what `list=allpages` returns:
    // "Beyond the Ruins" — the later chapter — comes first in the input.
    const top = parsed().document.root.children;
    const walkthrough = top.find((node) => node.label === 'Walkthrough');
    expect(walkthrough?.type === 'subject' && walkthrough.children.map((c) => c.label)).toEqual([
      'Walkthrough',
      'The Millennial Fair',
      'Beyond the Ruins',
    ]);
  });

  it('keeps every page exactly once', () => {
    // By id, not by label: a group can legitimately share a name with a page
    // inside it. StrategyWiki's index writes `{{h2|[[…|Walkthrough]]}}`, so the
    // Walkthrough section and the Walkthrough intro page are both "Walkthrough"
    // — which is how the wiki renders it too.
    const ids = [...walk(parsed().document.root)]
      .filter((node) => node.type === 'subject' && /^p:\d+$/.test(node.id ?? ''))
      .map((node) => node.id);
    expect(new Set(ids).size).toBe(pages.length);
  });
});
