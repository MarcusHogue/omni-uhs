/**
 * The web copy of `normalizeTitle` must agree with the proxy's copy exactly —
 * they group the same titles across sources, and a divergence would silently
 * split a game into two search results. The vectors are duplicated here rather
 * than imported so this test fails if either file drifts.
 */

import { describe, expect, it } from 'vitest';

import { normalizeTitle, stableId, fnv1a64 } from '../../src/parser/id.js';

const VECTORS: [string, string][] = [
  ['The Longest Journey', 'longest journey'],
  ['Longest Journey, The', 'longest journey'],
  ['A Mind Forever Voyaging', 'mind forever voyaging'],
  ['Mind Forever Voyaging, A', 'mind forever voyaging'],
  ['An Elder Scrolls Legend', 'elder scrolls legend'],
  ['Zork I: The Great Underground Empire', 'zork i the great underground empire'],
  ["King's Quest V", 'king s quest v'],
  ['  Myst  ', 'myst'],
  ['MYST', 'myst'],
  ['The 11th Hour', '11th hour'],
  ['Monkey Island 2: LeChuck’s Revenge', 'monkey island 2 lechuck s revenge'],
  ['Nancy Drew 31: Labyrinth of Lies', 'nancy drew 31 labyrinth of lies'],
];

describe('normalizeTitle', () => {
  for (const [input, expected] of VECTORS) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeTitle(input)).toBe(expected);
    });
  }

  it('groups the article variants together', () => {
    expect(normalizeTitle('The Longest Journey')).toBe(normalizeTitle('Longest Journey, The'));
  });

  it('keeps accented letters rather than stripping them', () => {
    expect(normalizeTitle('Amerzone: Le Testament de lʼExplorateur')).toContain('testament');
    expect(normalizeTitle('Pokémon Red')).toBe('pokémon red');
  });
});

describe('stableId', () => {
  it('is deterministic, so a re-download keeps its reveal state', () => {
    const url = 'https://www.uhs-hints.com/rfiles/zork1.zip';
    expect(stableId('uhs', url)).toBe(stableId('uhs', url));
  });

  it('separates sources that share a reference', () => {
    expect(stableId('uhs', 'x')).not.toBe(stableId('ifarchive', 'x'));
  });

  it('produces a fixed-width hex suffix', () => {
    expect(stableId('uhs', 'anything')).toMatch(/^uhs-[0-9a-f]{16}$/);
  });

  it('hashes each byte of a code unit, so wide characters matter', () => {
    expect(fnv1a64('é')).not.toBe(fnv1a64('e'));
  });
});
