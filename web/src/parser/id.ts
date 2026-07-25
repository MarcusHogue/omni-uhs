/**
 * Stable, dependency-free identifiers.
 *
 * Document ids must be reproducible: re-downloading a title has to land on the
 * same id so the stored reveal state still applies. A 64-bit FNV-1a over
 * `kind + ':' + ref` is plenty for a personal library and is trivial to
 * re-implement in Swift.
 */

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64(input: string): bigint {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Hash the UTF-16 code unit as two bytes so the result is byte-defined.
    hash = ((hash ^ BigInt(code & 0xff)) * PRIME) & MASK;
    hash = ((hash ^ BigInt((code >> 8) & 0xff)) * PRIME) & MASK;
  }
  return hash;
}

/** e.g. stableId('uhs', 'https://…/adv660.zip') -> 'uhs-1f3a…' */
export function stableId(kind: string, ref: string): string {
  return `${kind}-${fnv1a64(`${kind}:${ref}`).toString(16).padStart(16, '0')}`;
}

/**
 * Title normalization used for cross-source grouping.
 *
 * lowercase -> strip a leading or trailing article -> strip punctuation ->
 * collapse whitespace. Deliberately simple; a metadata API (IGDB/RAWG) is a v2
 * option if grouping quality disappoints.
 *
 * NOTE: the proxy keeps a byte-identical copy in `proxy/src/catalog/normalize.ts`
 * (it cannot import across the workspace boundary at container build time).
 * Both are covered by the same test vectors — change them together.
 */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().trim();
  // "Longest Journey, The" -> "the longest journey"
  const trailing = /^(.*),\s*(the|a|an)$/.exec(t);
  if (trailing) t = `${trailing[2]} ${trailing[1]}`;
  t = t.replace(/^(the|a|an)\s+/, '');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
