/**
 * Inverse of the UHS ciphers, used only to build synthetic test fixtures.
 *
 * This lives in `tools/` rather than `src/parser/` on purpose: the reader never
 * writes UHS files, and the parser must stay minimal for the Swift port.
 */

import { cp437Encode } from '../src/parser/uhs/cp437.js';

/**
 * Inverse of `decode88`.
 *
 *   plain even -> cipher = (plain + 32) / 2      (cipher < 80 branch)
 *   plain odd  -> cipher = (plain + 127) / 2     (cipher >= 80 branch)
 *
 * Control characters pass through, exactly as the forward cipher does. The 88a
 * cipher is only defined over 7-bit text, which is all it is ever used for.
 */
export function encode88(plain: string): Uint8Array {
  const bytes = cp437Encode(plain);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const p = bytes[i]!;
    if (p < 32) {
      out[i] = p;
      continue;
    }
    if (p > 127) throw new Error(`encode88: ${p} is outside the 7-bit range`);
    out[i] = p % 2 === 0 ? (p + 32) / 2 : (p + 127) / 2;
  }
  return out;
}

/**
 * Inverse of `decodeKey`.
 *
 * The forward cipher subtracts a per-position term and then adds 96 until the
 * value reaches 32, so encoding picks the multiple of 96 that keeps the cipher
 * byte inside 0..255.
 */
export function encodeKey(plain: string, key: Uint8Array, variant: 1 | 2): Uint8Array {
  const bytes = cp437Encode(plain);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const p = bytes[i]!;
    if (p < 32 || p > 127) {
      throw new Error(`encodeKey: ${p} is outside the encodable range`);
    }
    const co = i % key.length;
    const term = key[co]! ^ ((variant === 1 ? i : co) + 40);
    let value = p + term;
    while (value > 255) value -= 96;
    if (value < 0) throw new Error('encodeKey: no representable cipher byte');
    out[i] = value;
  }
  return out;
}
