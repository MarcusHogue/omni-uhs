/**
 * @vitest-environment node
 *
 * Node, not the jsdom that `test/ui/**` otherwise implies: this exercises
 * `buildIndex` and `searchLabels`, which are plain data. jsdom is not a
 * dependency of this project, so asking for it fails the run outright — with
 * every test still reporting green, which is how it went unnoticed.
 */

/**
 * The in-document find.
 *
 * Its contract is that it never surfaces an answer: it searches section and
 * question titles, and nothing else. A hint caption like "Solution to the
 * Antechamber door" is an answer, so a picture attached to a hint must stay out
 * of the index however the AST is walked elsewhere.
 */

import { describe, expect, it } from 'vitest';

import type { HintDocument } from '../../src/parser/ast.js';
import { buildIndex, searchLabels } from '../../src/ui/tree.js';

const document: HintDocument = {
  id: 'd',
  game: { title: 'Blue Prince' },
  source: { kind: 'fandom', url: 'https://x/', license: 'CC-BY-SA', personalUseOnly: true },
  fetchedAt: 'now',
  root: {
    id: 'p:root',
    type: 'subject',
    label: 'Blue Prince',
    children: [
      {
        id: 'p:0',
        type: 'hints',
        label: 'The Antechamber',
        hints: [
          {
            id: 'p:0:h0',
            type: 'hint',
            content: [{ kind: 'run', text: 'Turn the dials to match.' }],
            images: [
              {
                id: 'p:0:h0:i0',
                type: 'image',
                label: 'Solution to the Antechamber door',
                data: new Uint8Array(0),
                mime: '',
                blobKey: 'd|Door.png',
                source: { file: 'Door.png' },
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('buildIndex', () => {
  it('does not index a picture attached to a hint', () => {
    const index = buildIndex(document);
    expect(index.searchable.map((s) => s.label)).toEqual(['Blue Prince', 'The Antechamber']);
    // The caption *is* the answer, so finding it by typing "solution" would
    // hand it over without a tap.
    expect(searchLabels(index, 'solution')).toEqual([]);
    expect(searchLabels(index, 'antechamber').map((s) => s.id)).toEqual(['p:0']);
  });
});
