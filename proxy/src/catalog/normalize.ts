/**
 * Title normalization for cross-source grouping.
 *
 * IMPORTANT: this is a deliberate copy of `web/src/parser/id.ts`'s
 * `normalizeTitle`. The proxy container does not include the web workspace, so
 * the function cannot be imported across the boundary at build time. Both
 * copies are covered by the same test vectors in
 * `proxy/test/normalize.test.ts` and `web/test/parser/normalize.test.ts` —
 * change them together.
 */

export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().trim();
  const trailing = /^(.*),\s*(the|a|an)$/.exec(t);
  if (trailing) t = `${trailing[2]} ${trailing[1]}`;
  t = t.replace(/^(the|a|an)\s+/, '');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Shared by both copies' test suites. */
export const NORMALIZE_VECTORS: [input: string, expected: string][] = [
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
