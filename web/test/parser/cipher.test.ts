import { describe, expect, it } from 'vitest';

import { decode88, decodeKey, makeKey } from '../../src/parser/uhs/cipher.js';
import { cp437Decode, cp437Encode } from '../../src/parser/uhs/cp437.js';
import { encode88, encodeKey } from '../../tools/uhs-encode.js';

const bytes = (text: string): Uint8Array => cp437Encode(text);
const decoded = (input: Uint8Array): string => cp437Decode(input);

describe('88a cipher', () => {
  it('matches the worked example from the format spec', () => {
    // 'g' (103) -> 'O' (79)  via 2i - 127
    // 'H' (72)  -> 'p' (112) via 2i - 32
    expect(decoded(decode88(bytes('g')))).toBe('O');
    expect(decoded(decode88(bytes('H')))).toBe('p');
  });

  it('passes control characters straight through', () => {
    const input = Uint8Array.from([0x00, 0x09, 0x1f, 0x20]);
    const out = decode88(input);
    expect([...out.slice(0, 3)]).toEqual([0x00, 0x09, 0x1f]);
    // 0x20 is >= 32 so it is enciphered: 2*32 - 32 = 32.
    expect(out[3]).toBe(32);
  });

  it('applies the two branches at the documented boundary', () => {
    // i < 80 -> 2i - 32
    expect(decode88(Uint8Array.from([79]))[0]).toBe(2 * 79 - 32);
    // i >= 80 -> 2i - 127
    expect(decode88(Uint8Array.from([80]))[0]).toBe(2 * 80 - 127);
  });

  it('round-trips every printable 7-bit character', () => {
    let printable = '';
    for (let c = 32; c < 128; c++) printable += String.fromCharCode(c);
    expect(decoded(decode88(encode88(printable)))).toBe(printable);
  });
});

describe('key generation', () => {
  it('follows the documented recurrence', () => {
    const label = 'Sample';
    const key = makeKey(bytes(label));
    const k = [0x6b, 0x65, 0x79];
    for (let i = 0; i < label.length; i++) {
      let expected = label.charCodeAt(i) + (k[i % 3]! ^ (i + 40));
      while (expected > 127) expected -= 96;
      expect(key[i]).toBe(expected);
    }
  });

  it('keeps every byte inside the 7-bit range', () => {
    const key = makeKey(bytes('The Longest Possible Title Imaginable, Really'));
    for (const value of key) expect(value).toBeLessThanOrEqual(127);
  });
});

describe('key cipher', () => {
  const key = makeKey(bytes('The Nested Grotto'));

  it('round-trips variant 1 (nesthint, incentive)', () => {
    const plain = 'It only sleeps at noon, and never on a Tuesday.';
    expect(decoded(decodeKey(encodeKey(plain, key, 1), key, 1))).toBe(plain);
  });

  it('round-trips variant 2 (text)', () => {
    const plain = 'The grotto has three levels; only the middle one matters.';
    expect(decoded(decodeKey(encodeKey(plain, key, 2), key, 2))).toBe(plain);
  });

  it('distinguishes the two variants', () => {
    // The variants differ only in whether the XOR term counts the absolute
    // position or the position within the key, so they agree on the first
    // key-length characters and diverge after that.
    const plain = 'x'.repeat(key.length * 2);
    const asOne = encodeKey(plain, key, 1);
    const asTwo = encodeKey(plain, key, 2);
    expect([...asOne]).not.toEqual([...asTwo]);
    expect(decoded(decodeKey(asOne, key, 2))).not.toBe(plain);
  });

  it('uses the position within the key for variant 2', () => {
    const plain = 'abcdefghij';
    const out = decodeKey(encodeKey(plain, key, 2), key, 2);
    for (let i = 0; i < plain.length; i++) {
      const co = i % key.length;
      const cipher = encodeKey(plain, key, 2)[i]!;
      let expected = cipher - (key[co]! ^ (co + 40));
      while (expected < 32) expected += 96;
      expect(out[i]).toBe(expected);
    }
  });

  it('tolerates an empty key rather than dividing by zero', () => {
    const input = bytes('anything');
    expect([...decodeKey(input, new Uint8Array(), 1)]).toEqual([...input]);
  });
});
