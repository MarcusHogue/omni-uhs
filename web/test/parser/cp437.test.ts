import { describe, expect, it } from 'vitest';

import {
  asciiDecode,
  bytesEqualAscii,
  cp437Decode,
  cp437Encode,
} from '../../src/parser/uhs/cp437.js';

describe('CP437', () => {
  it('decodes ASCII unchanged', () => {
    expect(cp437Decode(Uint8Array.from([72, 105, 33]))).toBe('Hi!');
  });

  it('decodes the high range as CP437, not Latin-1 or UTF-8', () => {
    // 0x82 is 'é' in CP437 but '‚' in Windows-1252 and invalid in UTF-8.
    expect(cp437Decode(Uint8Array.from([0x82]))).toBe('é');
    // Box drawing, which a UTF-8 decode would mangle entirely.
    expect(cp437Decode(Uint8Array.from([0xc9, 0xcd, 0xbb]))).toBe('╔═╗');
    // 0xe1 is the Greek sharp s in CP437, not 'á'.
    expect(cp437Decode(Uint8Array.from([0xe1]))).toBe('ß');
  });

  it('round-trips through the encoder', () => {
    const text = 'Café ½ ± ╬ ß';
    expect(cp437Decode(cp437Encode(text))).toBe(text);
  });

  it('substitutes unrepresentable characters rather than throwing', () => {
    expect(cp437Decode(cp437Encode('emoji 🎮'))).toContain('emoji ');
  });

  it('compares structural markers byte-exactly', () => {
    expect(bytesEqualAscii(cp437Encode('-'), '-')).toBe(true);
    expect(bytesEqualAscii(cp437Encode('- '), '-')).toBe(false);
    expect(bytesEqualAscii(cp437Encode('='), '-')).toBe(false);
  });

  it('exposes a byte-faithful view for structural fields', () => {
    // asciiDecode must not remap high bytes; hunk headers and locators are
    // pure ASCII and parsing them through CP437 would be wrong for numbers.
    expect(asciiDecode(Uint8Array.from([0x33, 0x20, 0x6c]))).toBe('3 l');
  });
});
