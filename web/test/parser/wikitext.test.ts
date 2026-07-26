import { describe, expect, it } from 'vitest';

import type { HintGroupNode, SubjectNode, TextNode } from '../../src/parser/ast.js';
import { inlineText, walk } from '../../src/parser/ast.js';
import {
  looksLikeReference,
  parseWikiWalkthrough,
  proseChars,
  proseRatio,
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

describe('reference-page classifier', () => {
  const INFOBOX_PAGE = `{{npc infobox
| boxwidth = 31em
| auto = 113
| name = Wall of Flesh
| type = Boss
| ai = Wall of Flesh AI
| damage = 50
| life = 8000
| defense = 0
| immune = confused, poisoned
}}
{| class="terraria"
! Stat !! Value
|-
| Damage || 50
|}
The Wall of Flesh.`;

  it('calls a stat page reference data and a guide not', () => {
    expect(looksLikeReference(INFOBOX_PAGE)).toBe(true);
    expect(
      looksLikeReference('== Room 46 ==\nReach the antechamber and enter the code from the study.'),
    ).toBe(false);
  });

  it('keeps a page that is mostly template but has real prose in it', () => {
    // Blue Prince's Antechamber page is 11% prose and one of the most useful on
    // that wiki. A ratio-only gate dropped it; that was the bug.
    // Proportions taken from the real page: ~7.4k of template and table
    // markup around ~800 characters of guidance.
    const bulk = Array.from({ length: 300 }, (_, i) => `| field${i} = value ${i}`).join('\n');
    const page = `{{room infobox\n${bulk}\n}}\n\n== Description ==\n${'Reaching the antechamber is the first major goal. '.repeat(17)}`;
    expect(proseRatio(page)).toBeLessThan(0.15);
    expect(proseChars(page)).toBeGreaterThan(300);
    expect(looksLikeReference(page)).toBe(false);
  });

  it('skips reference pages when asked, and says which and why', () => {
    const { document, warnings } = parseWikiWalkthrough(
      [{ title: 'Wall of Flesh', wikitext: INFOBOX_PAGE, revision: '1' }],
      { ...OPTIONS, kind: 'wikigg', reveal: 'progressive', skipReferencePages: true },
    );
    expect(document.root.children).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/Wall of Flesh: skipped, reads as reference data/);
  });

  it('leaves the page alone when the classifier is off', () => {
    const { document } = parseWikiWalkthrough(
      [{ title: 'Wall of Flesh', wikitext: INFOBOX_PAGE, revision: '1' }],
      { ...OPTIONS, kind: 'wikigg', reveal: 'progressive' },
    );
    expect(document.root.children.length).toBeGreaterThan(0);
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
