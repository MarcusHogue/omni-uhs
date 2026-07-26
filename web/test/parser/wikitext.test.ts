import { describe, expect, it } from 'vitest';

import type { HintGroupNode, ParseResult, SubjectNode, TextNode } from '../../src/parser/ast.js';
import { inlineText, walk } from '../../src/parser/ast.js';
import {
  collectExpandable,
  orderedLinks,
  parseWikiWalkthrough,
  splitSections,
  stripMarkup,
} from '../../src/parser/wikitext/index.js';

const OPTIONS = {
  kind: 'strategywiki' as const,
  gameTitle: 'Test Game',
  baseUrl: 'https://strategywiki.org/wiki/',
  license: 'CC-BY-SA-4.0',
  personalUseOnly: false,
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

describe('wikitext markup', () => {
  it('keeps the display text of links', () => {
    expect(stripMarkup('Go to [[Test Game/Cave|the cave]] now')).toBe('Go to the cave now');
    expect(stripMarkup('See [[Chrono Trigger]]')).toBe('See Chrono Trigger');
    expect(stripMarkup('[https://example.com an example]')).toBe('an example');
  });

  it('drops images, references and comments', () => {
    expect(stripMarkup('[[File:Map.png|thumb|A map]] text')).toBe('text');
    expect(stripMarkup('fact<ref>a citation</ref> here')).toBe('fact here');
    expect(stripMarkup('visible<!-- hidden -->text')).toBe('visibletext');
  });

  it('unwraps bold and italic without leaving quotes behind', () => {
    expect(stripMarkup("'''bold''' and ''italic''")).toBe('bold and italic');
  });

  it('splits on headings of any level', () => {
    const sections = splitSections('lead\n== One ==\na\n=== Two ===\nb\n');
    expect(sections.map((s) => s.title)).toEqual(['', 'One', 'Two']);
    expect(sections.map((s) => s.level)).toEqual([1, 2, 3]);
  });
});

describe('wikitext to AST', () => {
  const page = {
    title: 'Test Game/Walkthrough',
    revision: '12345',
    wikitext: `Some intro text.

== Chapter One ==
Walk east twice.
* Pick up the lamp.
* Open the door.

=== The Locked Door ===
The door needs a key.
{{spoiler|The key is under the mat.}}

== Chapter Two ==
Nothing to see yet.
`,
  };

  const { document, warnings } = parseWikiWalkthrough([page], OPTIONS);

  it('parses without warnings', () => {
    expect(warnings).toEqual([]);
  });

  it('turns headings into a nested subject tree', () => {
    const subjects = [...walk(document.root)].filter(
      (n): n is SubjectNode => n.type === 'subject',
    );
    expect(subjects.map((s) => s.label)).toEqual([
      'Test Game',
      'Chapter One',
      'The Locked Door',
      'Chapter Two',
    ]);
    // === nests inside ==, rather than becoming a sibling.
    const chapterOne = subjects.find((s) => s.label === 'Chapter One')!;
    expect(chapterOne.children.some((c) => c.label === 'The Locked Door')).toBe(true);
  });

  it('keeps paragraphs and list items as readable text', () => {
    const text = [...walk(document.root)].find(
      (n): n is TextNode => n.type === 'text' && n.label === 'Chapter One',
    )!;
    expect(inlineText(text.content)).toContain('Walk east twice.');
    expect(inlineText(text.content)).toContain('Pick up the lamp.');
  });

  it('hides spoiler-templated content behind the usual reveal', () => {
    const spoilers = [...walk(document.root)].find(
      (n): n is HintGroupNode => n.type === 'hints',
    )!;
    expect(spoilers.label).toContain('spoilers');
    expect(spoilers.hints).toHaveLength(1);
    expect(inlineText(spoilers.hints[0]!.content)).toContain('key is under the mat');

    // And it must not have leaked into the plain text of its section.
    const plain = [...walk(document.root)]
      .filter((n): n is TextNode => n.type === 'text')
      .map((n) => inlineText(n.content))
      .join(' ');
    expect(plain).not.toContain('key is under the mat');
  });

  it('keeps a spoiler hidden but intact when it spans several lines', () => {
    // Dropping multi-line templates is right for infoboxes and wrong for this:
    // the answer lives inside, so the section would come back empty.
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Test Game',
          wikitext:
            '== The vault ==\nThe vault will not open.\n\n' +
            '{{spoiler|\nTurn the third dial to seven,\nthen pull the lever.\n}}\n',
          revision: '1',
        },
      ],
      OPTIONS,
    );
    const group = [...walk(document.root)].find(
      (n): n is HintGroupNode => n.type === 'hints',
    )!;
    expect(inlineText(group.hints[0]!.content)).toContain('Turn the third dial to seven');
    expect(inlineText(group.hints[0]!.content)).toContain('pull the lever');

    // ...and it is still hidden, not sitting in the visible prose.
    const visible = [...walk(document.root)]
      .filter((n): n is TextNode => n.type === 'text')
      .map((n) => inlineText(n.content))
      .join(' ');
    expect(visible).toContain('The vault will not open.');
    expect(visible).not.toContain('third dial');
  });

  it('still drops a multi-line infobox rather than reading it as prose', () => {
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Test Game',
          wikitext:
            '{{Infobox weapon\n| damage = 50\n| rarity = blue\n}}\n' +
            'The sword is behind the waterfall.\n',
          revision: '1',
        },
      ],
      OPTIONS,
    );
    const said = [...walk(document.root)]
      .filter((n): n is TextNode => n.type === 'text')
      .map((n) => inlineText(n.content))
      .join(' ');
    expect(said).toContain('behind the waterfall');
    expect(said).not.toContain('damage');
    expect(said).not.toContain('50');
  });

  it('keeps the word a one-parameter template stands in for', () => {
    // Blue Prince writes "a very complex and long {{roomtype|Puzzle}};", which
    // dropping the template turned into "a very complex and long ;".
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Room 46',
          wikitext:
            'It is a very complex and long {{roomtype|Puzzle}}; follow its page.\n' +
            '\n' +
            'Layout is {{Reflist|30em}}not prose{{clear}}, and ' +
            '{{tooltip|shown|hovered}}has no obvious answer.\n',
          revision: '1',
        },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );
    const said = [...walk(document.root)]
      .filter((n): n is HintGroupNode => n.type === 'hints')
      .flatMap((n) => n.hints.map((h) => inlineText(h.content)))
      .join(' ');
    expect(said).toContain('a very complex and long Puzzle;');
    // Layout and multi-parameter templates stay dropped: a bare dimension is
    // not prose, and which of two parameters is the display text is a guess.
    expect(said).toContain('Layout is not prose,');
    expect(said).not.toContain('30em');
    expect(said).not.toContain('hovered');
    expect(said).not.toContain('shown');
  });

  it('records the attribution CC-BY-SA requires', () => {
    expect(document.source.license).toBe('CC-BY-SA-4.0');
    expect(document.source.revision).toBe('12345');
    expect(document.source.attribution).toContain('strategywiki.org');
    expect(document.source.attribution).toContain('12345');
    expect(document.source.attribution).toContain('CC-BY-SA-4.0');
    expect(document.source.personalUseOnly).toBe(false);
  });

  it('skips redirects and empty pages without failing the whole download', () => {
    const result = parseWikiWalkthrough(
      [
        { title: 'Test Game/Old', wikitext: '#REDIRECT [[Test Game]]', revision: '1' },
        { title: 'Test Game/Blank', wikitext: '', revision: '2' },
        page,
      ],
      OPTIONS,
    );
    expect(result.warnings).toEqual(['Test Game/Blank: page is empty']);
    expect(result.document.root.children.length).toBeGreaterThan(0);
  });

  it('does not throw on a page of pure markup noise', () => {
    expect(() =>
      parseWikiWalkthrough(
        [{ title: 'Test Game', wikitext: '{{infobox|a=1|b={{nested}}}}', revision: null }],
        OPTIONS,
      ),
    ).not.toThrow();
  });
});

describe('reveal shape (spec §6.4)', () => {
  // A reference wiki marks nothing as an answer, so "as written" would put the
  // whole page on screen at once. That is the failure this guards.
  const REFERENCE_PAGE = `
Blue Prince is a puzzle game.

== The antechamber ==
Reach the antechamber with the correct keycard.

Enter 46 on the keypad using the code from the study.

The door opens onto the final room.
`;

  it('keeps StrategyWiki pages as written, revealed on arrival', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Test Game', wikitext: REFERENCE_PAGE, revision: '1' }],
      OPTIONS,
    );
    const kinds = collectTypes(document.root);
    expect(kinds).toContain('text');
    expect(kinds).not.toContain('hints');
  });

  it('turns a reference page into hints that reveal one at a time', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Room 46', wikitext: REFERENCE_PAGE, revision: '1' }],
      { ...OPTIONS, kind: 'fandom', baseUrl: 'https://blue-prince.fandom.com/wiki/', reveal: 'progressive' },
    );
    const kinds = collectTypes(document.root);
    // No pre-revealed prose anywhere in the tree.
    expect(kinds).not.toContain('text');
    expect(kinds).toContain('hints');

    // The section heading becomes the question, its paragraphs the steps.
    const group = findHints(document.root, 'The antechamber')!;
    expect(group).toBeTruthy();
    expect(group.hints).toHaveLength(3);
  });

  it('does not make you tap through a section to reach its only hint group', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Room 46', wikitext: REFERENCE_PAGE, revision: '1' }],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );
    // "The antechamber" has no sub-headings, so its wrapper subject held one
    // group with the identical label — two taps and the same word twice.
    const child = document.root.children.find((node) => node.label === 'The antechamber');
    expect(child?.type).toBe('hints');
  });

  it('keeps the wrapper when a section really does have sub-sections', () => {
    const nested = `
Intro prose long enough to count as a paragraph of guidance.

== Puzzles ==
Some general advice about the puzzles in this game.

=== The keypad ===
Enter the code from the study.
`;
    const { document } = parseWikiWalkthrough(
      [{ title: 'Room 46', wikitext: nested, revision: '1' }],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );
    const puzzles = document.root.children.find((node) => node.label === 'Puzzles');
    expect(puzzles?.type).toBe('subject');
    // ...and the leaf below it is still collapsed.
    const keypad = (puzzles as SubjectNode).children.find(
      (node) => node.label === 'The keypad',
    );
    expect(keypad?.type).toBe('hints');
  });

  it('drops category filing instead of reading it as a hint', () => {
    // `[[Category:Creatures]]` renders as nothing in a page body — MediaWiki
    // puts it in a footer — so passing the text through produced a hint that
    // read "Category:Creatures".
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Manticore',
          wikitext:
            'The manticore guards the east door until you show it the seal.\n\n' +
            '[[Category:Creatures]]\n[[Category:Bosses]]\n',
          revision: '1',
        },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );
    const said = [...walk(document.root)]
      .filter((n): n is HintGroupNode => n.type === 'hints')
      .flatMap((n) => n.hints.map((h) => inlineText(h.content)));
    expect(said.join(' ')).toContain('guards the east door');
    expect(said.join(' ')).not.toContain('Category');
    // And no hint exists that was *only* a category.
    expect(said.every((text) => text.trim().length > 0)).toBe(true);
  });

  it('links a page that is in the download, and flattens one that is not', () => {
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Room 46',
          wikitext:
            'The door is opened from [[The Antechamber]], not from here.\n\n' +
            'It has nothing to do with the [[Boiler Room]], despite the rumours.\n',
          revision: '1',
        },
        {
          title: 'The Antechamber',
          wikitext: 'Enter the code from the study on the keypad by the door.\n',
          revision: '2',
        },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );

    const runs = [...walk(document.root)]
      .filter((n): n is HintGroupNode => n.type === 'hints')
      .flatMap((n) => n.hints.flatMap((h) => h.content));

    const link = runs.find((item) => item.kind === 'link');
    expect(link).toMatchObject({ kind: 'link', label: 'The Antechamber' });

    // The target is a real node, or the reader has a button that goes nowhere.
    const ids = new Set([...walk(document.root)].map((n) => n.id));
    expect(ids.has((link as { targetId: string }).targetId)).toBe(true);

    // Boiler Room was not downloaded, so it stays as text rather than becoming
    // a dead end.
    expect(runs.some((i) => i.kind === 'link' && i.label === 'Boiler Room')).toBe(false);
    expect(runs.map((i) => (i.kind === 'run' ? i.text : '')).join('')).toContain('Boiler Room');
  });

  it('keeps the spaces around a link', () => {
    const { document } = parseWikiWalkthrough(
      [
        { title: 'A', wikitext: 'Go to [[B]] and wait there.\n', revision: '1' },
        { title: 'B', wikitext: 'This is the place you were told to wait.\n', revision: '2' },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive' },
    );
    const group = [...walk(document.root)].find(
      (n): n is HintGroupNode => n.type === 'hints',
    )!;
    expect(inlineText(group.hints[0]!.content)).toBe('Go to B and wait there.');
  });

  it('records Fandom attribution from the wiki it actually came from', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Room 46', wikitext: REFERENCE_PAGE, revision: '9912' }],
      {
        ...OPTIONS,
        kind: 'fandom',
        baseUrl: 'https://blue-prince.fandom.com/wiki/',
        license: 'CC-BY-SA',
        reveal: 'progressive',
      },
    );
    expect(document.source.url).toContain('blue-prince.fandom.com');
    expect(document.source.attribution).toContain('blue-prince.fandom.com');
    expect(document.source.attribution).toContain('9912');
  });

  it('carries a non-commercial licence through as personal-use-only', () => {
    // Terraria and Minecraft are CC-BY-NC-SA: the wikis most worth having are
    // the ones that must never reach a shareable export.
    const { document } = parseWikiWalkthrough(
      [{ title: 'Wall of Flesh', wikitext: REFERENCE_PAGE, revision: '1' }],
      {
        ...OPTIONS,
        kind: 'wikigg',
        baseUrl: 'https://terraria.wiki.gg/wiki/',
        license: 'CC-BY-NC-SA-4.0',
        personalUseOnly: true,
        reveal: 'progressive',
      },
    );
    expect(document.source.personalUseOnly).toBe(true);
  });
});

describe('templates standing in for words', () => {
  const parse = (wikitext: string): ParseResult =>
    parseWikiWalkthrough([{ title: 'Billiard Room', wikitext, revision: '1' }], {
      ...OPTIONS,
      kind: 'wikigg',
      reveal: 'progressive',
      rank: true,
    });

  const text = (wikitext: string): string =>
    [...walk(parse(wikitext).document.root)]
      .flatMap((node) => (node.type === 'hints' ? node.hints : []))
      .map((hint) => inlineText(hint.content))
      .join(' | ');

  it('keeps the styled text of a two-parameter colour template', () => {
    // Real, from blueprince.wiki.gg's dartboard solution. The colour *is* the
    // answer, and dropping the template took the only word that mattered:
    // "### {{ColorText|add|Blue}} is addition." came out as " is addition."
    expect(text('== Solution ==\n# {{ColorText|add|Blue}} is addition.\n')).toContain(
      'Blue is addition.',
    );
  });

  it('reads the last unnamed parameter, which is where wikitext puts the text', () => {
    expect(text('== S ==\nThe {{Color|#f00|crimson door}} opens.\n')).toContain(
      'The crimson door opens.',
    );
    // Named parameters are configuration and do not count towards the arity.
    expect(text('== S ==\nA {{Font|serif text|face=serif}} sign.\n')).toContain(
      'A serif text sign.',
    );
  });

  it('still refuses a two-parameter template whose roles it cannot know', () => {
    // Not every template puts the display text last; guessing would show the
    // hover text instead of what is on screen.
    expect(text('== S ==\nThe {{tooltip|shown|hovered}} thing.\n')).not.toContain('hovered');
  });

  it('still drops layout parameters', () => {
    const out = text('== S ==\nSome prose.{{Reflist|30em}}\n');
    expect(out).toContain('Some prose.');
    expect(out).not.toContain('30em');
  });
});

describe('markup that is not markup', () => {
  it('strips a tag only when the name is one', () => {
    // Matching any `<name …>` is not safe: in `if x<y and a=b>0` the middle
    // reads as a tag called `y` with two attributes, and stripping it left
    // `if x0`. Attribute syntax does not disambiguate it either — `and a=b` is
    // valid attribute syntax — so the name has to be known.
    expect(stripMarkup('if x<y and a=b>0')).toBe('if x<y and a=b>0');
    expect(stripMarkup('if x<y and a>b')).toBe('if x<y and a>b');
    expect(stripMarkup('damage <10 per hit')).toBe('damage <10 per hit');

    // And the tags that actually turned up across six wikis all go.
    expect(stripMarkup('<h2>Usefulness</h2> text')).toBe('Usefulness text');
    expect(stripMarkup('<p class="MsoNormal">para</p>')).toBe('para');
    expect(stripMarkup('<noinclude>x</noinclude>')).toBe('x');
    expect(stripMarkup('<twitterfeed theme=dark linkcolor=#5a93cc>feed</twitterfeed>')).toBe(
      'feed',
    );
    expect(stripMarkup('<code>FIND_RABBIT</code>')).toBe('FIND_RABBIT');
    // `<math>` goes; the arithmetic inside it is the content.
    expect(stripMarkup('<math>0 + 5 + 13 = 18</math>')).toBe('0 + 5 + 13 = 18');
  });

  it('does not read a layout template\'s parameter as a word', () => {
    // A lone unnamed parameter is normally the word the template stands in for
    // — `{{roomtype|Puzzle}}` — and nothing about the *value* separates that
    // from `{{floatingtoc|left}}`, where "left" is a position. Chrono Trigger
    // puts one at the top of every chapter, so "left" opened every chapter.
    expect(stripMarkup('{{floatingtoc|left}}After naming the protagonist')).toBe(
      'After naming the protagonist',
    );
    expect(stripMarkup('{{col|4|begin}}Gameplay')).toBe('Gameplay');
    expect(stripMarkup('{{control selector|SNES,DS}}Prose')).toBe('Prose');
    // And a template that really is standing in for a word still is.
    expect(stripMarkup('a long {{roomtype|Puzzle}};')).toBe('a long Puzzle;');
  });

  it('keeps the pointer when a link label was nothing but a template', () => {
    // StrategyWiki writes `[[../Tabs|{{ctcontrol|Power Tab|Strength Capsule}}]]`
    // — two unnamed parameters, so the template is dropped as unreadable, which
    // emptied the label and left `[[../Tabs|]]`. Neither link pattern matches
    // that, so a section heading showed the residue `../Tabs|`, and in prose the
    // whole reference vanished. The target's own name stands in for it.
    expect(stripMarkup('There is one [[../Tabs|{{ctcontrol|Power Tab|Capsule}}]] to grab')).toBe(
      'There is one Tabs to grab',
    );
    expect(stripMarkup('the [[Chrono Trigger/Characters#Lavos]] fight')).toBe(
      'the Characters fight',
    );
  });
});

describe('relative links', () => {
  // StrategyWiki's house style, and it was silently costing every cross-
  // reference in a game. `Chrono Trigger/The Millennial Fair` points at its
  // sibling as `[[../Characters#Crono|Crono]]`, which normalised to
  // `../Characters` — matching no downloaded page — so the link quietly became
  // plain text. There are dozens per chapter.
  const parse = (): ParseResult =>
    parseWikiWalkthrough(
      [
        {
          title: 'Chrono Trigger/The Millennial Fair',
          revision: '1',
          wikitext: 'Talk to [[../Characters#Crono|Crono]] and see [[/Shops|the shops]].',
        },
        { title: 'Chrono Trigger/Characters', revision: '2', wikitext: 'Crono is the hero.' },
        {
          title: 'Chrono Trigger/The Millennial Fair/Shops',
          revision: '3',
          wikitext: 'Melchior sells swords.',
        },
      ],
      { ...OPTIONS, gameTitle: 'Chrono Trigger' },
    );

  it('resolves ../sibling and /child against the page they are on', () => {
    const { document } = parse();
    const links = [...walk(document.root)]
      .flatMap((n) => (n.type === 'text' ? n.content : []))
      .filter((i) => i.kind === 'link');
    expect(links.map((l) => l.label)).toEqual(['Crono', 'the shops']);
    // And they point somewhere real, which is the whole difference.
    const ids = new Set([...walk(document.root)].map((n) => n.id));
    for (const link of links) expect(ids.has(link.targetId)).toBe(true);
  });

  it('leaves a link alone when there is no page to resolve it against', () => {
    // `stripMarkup` has no page context, so `../X` cannot mean anything; it
    // must not be guessed at, only rendered by its leaf name.
    expect(stripMarkup('see [[../Characters|the cast]]')).toBe('see the cast');
  });
});

describe('orderedLinks', () => {
  // Shaped after StrategyWiki, where a game's chapters are sibling subpages and
  // the Walkthrough page is the hand-ordered index that names them. The order is
  // the whole value: a walkthrough sorted alphabetically is not a walkthrough,
  // and `prop=links` returns alphabetical, so it has to come from the wikitext.
  const INDEX = `{{Header Nav|game=Chrono Trigger}}
The walkthrough is split by era.

==Walkthrough==
* [[Chrono Trigger/The Millennial Fair|The Millennial Fair]]
* [[Chrono Trigger/Beyond the Ruins]]
* [[Chrono Trigger/Break the Seal!]]

==Appendices==
* [[Chrono Trigger/Characters]]
* [[:Category:Chrono Trigger]]
* [[fr:Chrono Trigger]]
`;

  it('keeps the page order, not alphabetical order', () => {
    expect(orderedLinks(INDEX).map((link) => link.title)).toEqual([
      'Chrono Trigger/The Millennial Fair',
      'Chrono Trigger/Beyond the Ruins',
      'Chrono Trigger/Break the Seal!',
      'Chrono Trigger/Characters',
    ]);
  });

  it('says which section each link sat under', () => {
    // How the appendices are found without hard-coding their titles.
    const bySection = orderedLinks(INDEX).map((link) => link.section);
    expect(bySection).toEqual(['Walkthrough', 'Walkthrough', 'Walkthrough', 'Appendices']);
  });

  it('leaves out filing and interwiki links', () => {
    const titles = orderedLinks(INDEX).map((link) => link.title);
    expect(titles.join(' ')).not.toContain('Category:');
    expect(titles).not.toContain('Fr:Chrono Trigger');
  });

  it('drops duplicates, keeping the first appearance', () => {
    const links = orderedLinks('* [[A]]\n* [[B]]\n* [[A]]\n');
    expect(links.map((link) => link.title)).toEqual(['A', 'B']);
  });

  it('ignores pictures and navigation templates', () => {
    // A nav box expands to links that are not this page's ordering, and a file
    // link is a picture rather than a chapter.
    const links = orderedLinks('[[File:Map.png|thumb|see [[Cave]]]]\n{{Footer Nav|game=X}}\n* [[Real]]\n');
    expect(links.map((link) => link.title)).toEqual(['Real']);
  });
});

describe('template expansion', () => {
  const parse = (wikitext: string, expanded: Record<string, string> = {}): ParseResult =>
    parseWikiWalkthrough([{ title: 'Secret rabbits', wikitext, revision: '1' }], {
      ...OPTIONS,
      kind: 'wikigg',
      reveal: 'progressive',
      rank: true,
      expanded,
    });

  const text = (wikitext: string, expanded: Record<string, string> = {}): string =>
    [...walk(parse(wikitext, expanded).document.root)]
      .flatMap((node) => (node.type === 'hints' ? node.hints : []))
      .map((hint) => inlineText(hint.content))
      .join(' | ');

  const PAGE = '== Rabbits ==\nA secret collectible animal in {{AW}}.\n';

  it('asks only about the calls it was going to drop', () => {
    // `{{ColorText|add|Blue}}` is already readable, so asking about it would be
    // a request spent on an answer already in hand.
    const calls = collectExpandable(
      '{{AW}} and {{ColorText|add|Blue}} and {{short|3-3}}\n',
    );
    expect(calls).toContain('AW');
    expect(calls).toContain('short|3-3');
    expect(calls).not.toContain('ColorText|add|Blue');
  });

  it('leaves out anything whose answer depends on the page', () => {
    // Expansions are batched across a whole game, so there is no page to answer
    // for. A shared answer would be confidently wrong rather than merely absent.
    expect(collectExpandable('Welcome to {{PAGENAME}}.\n')).toEqual([]);
    expect(collectExpandable('See {{SITENAME}}.\n')).toEqual([]);
  });

  it('puts the word back, and reads the result as wikitext', () => {
    // Real: animalwell.wiki.gg writes the game's name as {{AW}}, so the sentence
    // arrived as "a secret collectible animal in ." — and now that orphaned
    // spaces are closed up, as the *seamless* "animal in.", which is worse: the
    // gap was at least visible. Expansion is what makes closing them honest.
    expect(text(PAGE)).toContain('animal in.');
    expect(text(PAGE, { AW: "''[[Animal Well]]''" })).toContain('animal in Animal Well.');
  });

  it('refuses an expansion that is a block rather than a phrase', () => {
    // Tunic's {{Stub}} expands to a `<div><table>` notice; Reflist to a list.
    const out = text('== S ==\nProse.{{Stub}}\n', {
      Stub: '<div class="nomobile"><table style="">a stub notice</table></div>',
    });
    expect(out).toContain('Prose.');
    expect(out).not.toContain('stub notice');
  });

  it('behaves exactly as before when nothing was expanded', () => {
    expect(text(PAGE, {})).toBe(text(PAGE));
  });

  it('looks up own properties only', () => {
    // A wiki is untrusted input. `{{constructor}}` on a plain object resolves
    // to `Object` — truthy, so optional chaining waves it through — and calling
    // `.trim()` on a function throws and takes the whole download with it.
    expect(() => text('== S ==\nA {{constructor}} here.\n')).not.toThrow();
    expect(() => text('== S ==\nA {{toString}} here.\n')).not.toThrow();
    expect(text('== S ==\nA {{constructor}} here.\n')).toContain('A here.');
  });
});

describe('guidance ranking (spec §6.4)', () => {
  const GUIDE = `== Strategy ==
You need to break the crystal first, then jump to the ledge on the right and
use the grapple before the platform falls. Make sure you have the charm equipped.

== Trivia ==
The boss was named after a developer's cat.

== References ==
<ref>Interview, 2019</ref>
`;

  const parse = (wikitext: string, title = 'Moorwing'): ParseResult =>
    parseWikiWalkthrough([{ title, wikitext, revision: '1' }], {
      ...OPTIONS,
      kind: 'fandom',
      reveal: 'progressive',
      rank: true,
    });

  it('drops sections that are never a hint', () => {
    const labels = [...walk(parse(GUIDE).document.root)].map((n) => n.label);
    expect(labels).toContain('Strategy');
    expect(labels).not.toContain('Trivia');
    expect(labels).not.toContain('References');
  });

  it('labels instructional prose as guidance', () => {
    const group = [...walk(parse(GUIDE).document.root)].find(
      (n): n is HintGroupNode => n.type === 'hints',
    )!;
    expect(group.role).toBe('guidance');
  });

  it('never labels a section reference for scoring low', () => {
    // Return of the Obra Dinn is the reason. Its answers are facts -- an
    // "Identification" section states who someone is -- so they score zero on
    // instructional language while being the most spoiler-bearing content on
    // the wiki. Dropping or hiding those would lose the whole game.
    const obraDinn = `== Identification ==
The man in the blue coat is Alexander Booth, third mate, killed by a musket
shot during the mutiny in Chapter 4. His body was recovered from the deck.
`;
    const { document } = parse(obraDinn, 'Alexander Booth');
    const group = [...walk(document.root)].find(
      (n): n is HintGroupNode => n.type === 'hints',
    );
    expect(group).toBeTruthy();
    expect(group!.hints.length).toBeGreaterThan(0);
    // Present and readable.
    expect(inlineText(group!.hints[0]!.content)).toContain('Alexander Booth');
    // And unlabelled, not labelled `reference`. A "not a hint" pill on the
    // answer to the game is worse than no pill at all.
    expect(group!.role).toBeUndefined();
  });

  it('drops a reference heading whether it is singular or plural', () => {
    // Hollow Knight writes `== Appearance ==`; Obra Dinn writes
    // `== Appearances ==`. Both are description, neither is a hint.
    const labels = [
      ...walk(parse('== Appearance ==\nIt is a large winged beast.\n').document.root),
    ].map((n) => n.label);
    expect(labels).not.toContain('Appearance');
  });

  it('leads with the pages that read like guidance', () => {
    const { document } = parseWikiWalkthrough(
      [
        {
          title: 'Alexander Booth',
          wikitext: '== Story ==\nHe was a third mate aboard the ship, from Falmouth.\n',
          revision: '1',
        },
        { title: 'Moorwing', wikitext: GUIDE, revision: '2' },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive', rank: true },
    );
    const top = document.root.children.map((n) => n.label);
    expect(top.indexOf('Moorwing')).toBeGreaterThanOrEqual(0);
    expect(top.indexOf('Moorwing')).toBeLessThan(top.indexOf('Alexander Booth'));
  });

  it('offers an index of the likely guidance, without removing anything', () => {
    const { document } = parseWikiWalkthrough(
      [
        { title: 'Moorwing', wikitext: GUIDE, revision: '1' },
        { title: 'Nosk', wikitext: GUIDE.replace('Strategy', 'How to beat it'), revision: '2' },
        { title: 'Lore', wikitext: '== Story ==\nThe kingdom fell long ago and was forgotten.\n', revision: '3' },
      ],
      { ...OPTIONS, kind: 'fandom', reveal: 'progressive', rank: true },
    );
    const index = document.root.children[0];
    expect(index?.label).toBe('Likely guidance');
    expect((index as SubjectNode).children.length).toBeGreaterThanOrEqual(2);

    // Every entry points at a node that is really there.
    const ids = new Set([...walk(document.root)].map((n) => n.id));
    for (const link of (index as SubjectNode).children) {
      expect(ids.has((link as { targetId: string }).targetId)).toBe(true);
    }
    // And the low-scoring page is still in the document, not filtered out.
    expect(document.root.children.map((n) => n.label)).toContain('Lore');
  });

  it('leaves StrategyWiki alone', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Test Game', wikitext: GUIDE, revision: '1' }],
      OPTIONS,
    );
    // No ranking means no index and no dropped sections.
    expect([...walk(document.root)].map((n) => n.label)).toContain('Trivia');
  });
});

/** Every node type present in the tree. */
function collectTypes(node: { type: string; children?: unknown[] }): string[] {
  const out = [node.type];
  for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
    out.push(...collectTypes(child));
  }
  return out;
}

/** The hint group with a given label, anywhere in the tree. */
function findHints(
  node: { type: string; label?: string; children?: unknown[] },
  label: string,
): { label: string; hints: unknown[] } | null {
  if (node.type === 'hints' && node.label === label) {
    return node as unknown as { label: string; hints: unknown[] };
  }
  for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) {
    const found = findHints(child, label);
    if (found) return found;
  }
  return null;
}
