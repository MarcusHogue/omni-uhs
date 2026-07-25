import { describe, expect, it } from 'vitest';

import type { HintGroupNode, SubjectNode, TextNode } from '../../src/parser/ast.js';
import { inlineText, walk } from '../../src/parser/ast.js';
import { parseInvisiclues } from '../../src/parser/invisiclues/index.js';

/** Shaped exactly like the IF Archive's .inv files. */
const SAMPLE = `***************************************************************************
*                             InvisiClues(tm)                             *
*                          The Hint Booklet for                           *
*                            Test Adventure                               *
***************************************************************************

[Copyright by Someone. Provided for non-commercial use only.]

Above Ground
************

Where do I find a machete?
     There is none. The game must have _some_ limitations. You can't expect
     to walk to the nearest airport.

How do I cross the mountains?
     Play the sequel.

Is the nest useful for anything?
  A. In China you might make bird's nest soup.
  B. This is not China.
  C. In other words, no.

The Cellar
**********

How do I get past the troll?
  A. Have you tried giving him something?
  B. The sword works too.
`;

describe('InvisiClues', () => {
  const { document, warnings } = parseInvisiclues(SAMPLE, { title: 'Test Adventure' });
  const groups = [...walk(document.root)].filter(
    (n): n is HintGroupNode => n.type === 'hints',
  );
  const sections = document.root.children.filter(
    (n): n is SubjectNode => n.type === 'subject',
  );

  it('parses without warnings', () => {
    expect(warnings).toEqual([]);
  });

  it('does not mistake the asterisk title box for a section', () => {
    // The middle line of the banner sits above a row of asterisks and would
    // otherwise look exactly like an underlined heading.
    for (const section of sections) {
      expect(section.label).not.toMatch(/^\*/);
      expect(section.label).not.toMatch(/InvisiClues/);
    }
    expect(sections.map((s) => s.label)).toEqual(['Above Ground', 'The Cellar']);
  });

  it('keeps the front matter as a note rather than dropping it', () => {
    const about = document.root.children.find(
      (n): n is TextNode => n.type === 'text' && n.label === 'About this file',
    );
    expect(about).toBeDefined();
    expect(inlineText(about!.content)).toContain('non-commercial');
  });

  it('splits consecutive questions instead of merging them', () => {
    expect(groups.map((g) => g.label)).toEqual([
      'Where do I find a machete?',
      'How do I cross the mountains?',
      'Is the nest useful for anything?',
      'How do I get past the troll?',
    ]);
  });

  it('treats an unlettered indented block as one answer', () => {
    const machete = groups[0]!;
    expect(machete.hints).toHaveLength(1);
    expect(inlineText(machete.hints[0]!.content)).toContain('There is none');
    // The wrapped continuation lines belong to the same answer.
    expect(inlineText(machete.hints[0]!.content)).toContain('nearest airport');
  });

  it('makes each lettered answer a separate, progressively revealed hint', () => {
    const nest = groups[2]!;
    expect(nest.hints).toHaveLength(3);
    expect(inlineText(nest.hints[0]!.content)).toBe(
      'In China you might make bird’s nest soup.'.replace('’', "'"),
    );
    expect(inlineText(nest.hints[2]!.content)).toBe('In other words, no.');
  });

  it('marks these files personal-use-only', () => {
    // Most InvisiClues transcriptions carry an explicit non-commercial notice,
    // so they are never exported (spec §11).
    expect(document.source.personalUseOnly).toBe(true);
  });

  it('does not throw on an empty or unstructured file', () => {
    expect(() => parseInvisiclues('')).not.toThrow();
    expect(parseInvisiclues('just some prose\nwith no structure').warnings.length).toBe(1);
  });
});
