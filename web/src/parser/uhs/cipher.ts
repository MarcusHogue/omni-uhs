/**
 * The three UHS ciphers.
 *
 * Everything here operates on raw byte values, never on decoded characters:
 * decrypt first, CP437-decode afterwards. Doing it the other way round breaks
 * on every high byte.
 *
 * Ported from freeuhs (public domain / Unlicense). OpenUHS was consulted as an
 * oracle only; no GPL code is reproduced here.
 */

/**
 * The 88a cipher, used for `hint` bodies and every 88a-section string.
 *
 *   i < 32  -> i           (control characters pass through)
 *   i < 80  -> 2i - 32
 *   else    -> 2i - 127
 *
 * Worked example from the spec: 'g' (103) -> 79 ('O'), 'H' (72) -> 112 ('p').
 */
export function decode88(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out[i] = b < 32 ? b : b < 80 ? 2 * b - 32 : 2 * b - 127;
  }
  return out;
}

/** Literal seed string "key" from the format spec. */
const K = [0x6b, 0x65, 0x79];

/**
 * Derive the 95a/96a main key from the root subject's label bytes.
 *
 *   key[i] = label[i] + (k[i mod 3] XOR (i + 40));  while key[i] > 127: -= 96
 */
export function makeKey(labelBytes: Uint8Array): Uint8Array {
  const key = new Uint8Array(labelBytes.length);
  for (let i = 0; i < labelBytes.length; i++) {
    let v = labelBytes[i]! + (K[i % 3]! ^ (i + 40));
    while (v > 127) v -= 96;
    key[i] = v;
  }
  return key;
}

/**
 * Key cipher.
 *
 *   co       = i mod len(key)
 *   out[i]   = msg[i] - (key[co] XOR ((variant === 1 ? i : co) + 40))
 *   while out[i] < 32: out[i] += 96
 *
 * Variant 1 is used by `nesthint` and `incentive`; variant 2 by `text`. The
 * only difference is whether the XOR term counts the absolute position or the
 * position within the key.
 */
export function decodeKey(
  bytes: Uint8Array,
  key: Uint8Array,
  variant: 1 | 2,
): Uint8Array {
  const out = new Uint8Array(bytes.length);
  if (key.length === 0) return Uint8Array.from(bytes);
  for (let i = 0; i < bytes.length; i++) {
    const co = i % key.length;
    let v = bytes[i]! - (key[co]! ^ ((variant === 1 ? i : co) + 40));
    while (v < 32) v += 96;
    out[i] = v;
  }
  return out;
}
