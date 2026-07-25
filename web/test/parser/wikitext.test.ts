import { describe, expect, it } from 'vitest';

import type { HintGroupNode, SubjectNode, TextNode } from '../../src/parser/ast.js';
import { inlineText, walk } from '../../src/parser/ast.js';
import { parseWikiWalkthrough, splitSections, stripMarkup } from '../../src/parser/wikitext/index.js';

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
