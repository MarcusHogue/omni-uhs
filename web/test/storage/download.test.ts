/**
 * The download pipeline's pure parts: unzipping and text decoding. The network
 * and IndexedDB halves are covered by the Playwright suite against the real
 * stack.
 */

import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decodeText, extractUhs } from '../../src/storage/download.js';
import { buildTiny88a } from '../../tools/fixtures/definitions.js';

describe('extractUhs', () => {
  const uhs = buildTiny88a();

  it('pulls the .uhs member out of a zip', () => {
    const zip = zipSync({ 'CAVE.UHS': uhs, 'readme.txt': new Uint8Array([65]) });
    expect([...extractUhs(zip)]).toEqual([...uhs]);
  });

  it('is case-insensitive about the member name', () => {
    expect([...extractUhs(zipSync({ 'cave.uhs': uhs }))]).toEqual([...uhs]);
  });

  it('passes a bare .uhs file straight through', () => {
    // The IF Archive serves uncompressed files; only uhs-hints.com zips them.
    expect([...extractUhs(uhs)]).toEqual([...uhs]);
  });

  it('falls back to the only member when nothing is named .uhs', () => {
    expect([...extractUhs(zipSync({ hints: uhs }))]).toEqual([...uhs]);
  });

  it('explains itself when the archive holds nothing usable', () => {
    expect(() => extractUhs(zipSync({}))).toThrow(/no \.uhs file/);
  });
});

describe('decodeText', () => {
  it('decodes UTF-8', () => {
    expect(decodeText(new TextEncoder().encode('café ✓'))).toBe('café ✓');
  });

  it('falls back to Latin-1 for older archive files rather than mangling them', () => {
    // 0xE9 is a lone 'é' in Latin-1 and invalid UTF-8; a lossy decode would
    // turn it into U+FFFD.
    const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeText(bytes)).toBe('café');
    expect(decodeText(bytes)).not.toContain('�');
  });
});
