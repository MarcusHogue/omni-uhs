/**
 * Behavioural tests for the UHS parser.
 *
 * These assert against the plaintext that went *into* the synthetic fixtures
 * (tools/fixtures/definitions.ts), not against a snapshot of the parser's own
 * output — so a regression in decryption shows up as a failing assertion rather
 * than a quietly-updated golden file. The golden files are covered separately
 * in fixtures.test.ts.
 */

import { describe, expect, it } from 'vitest';

import type { HintGroupNode, ImageNode, SubjectNode, TextNode } from '../../src/parser/ast.js';
import { inlineText, walk } from '../../src/parser/ast.js';
import { asciiDecode } from '../../src/parser/uhs/cp437.js';
import { parseUhs } from '../../src/parser/uhs/index.js';
import {
  IMAGE_96A,
  NESTED_95A,
  TINY_88A,
  TINY_PNG,
  buildImage96a,
  buildNested95a,
  buildTiny88a,
} from '../../tools/fixtures/definitions.js';

const find = <T extends { type: string }>(root: SubjectNode, type: string, label: string): T => {
  for (const node of walk(root)) {
    if (node.type === type && 'label' in node && node.label === label) return node as unknown as T;
  }
  throw new Error(`no ${type} labelled "${label}"`);
};

describe('88a section', () => {
  const { document, warnings } = parseUhs(buildTiny88a());

  it('reads the plaintext title from the header', () => {
    expect(document.game.title).toBe(TINY_88A.title);
  });

  it('rebuilds the subject / question / hint hierarchy', () => {
    const labels = document.root.children.map((c) => 'label' in c && c.label);
    expect(labels).toEqual(TINY_88A.subjects.map((s) => s.label));
  });

  it('decrypts question labels and hint bodies', () => {
    const group = find<HintGroupNode>(document.root, 'hints', 'How do I open the door?');
    expect(group.hints.map((h) => inlineText(h.content))).toEqual(
      TINY_88A.subjects[0]!.questions[0]!.hints,
    );
  });

  it('bounds the final question with the header last-hint pointer', () => {
    const group = find<HintGroupNode>(document.root, 'hints', 'What now?');
    expect(group.hints.map((h) => inlineText(h.content))).toEqual(['Go north twice.']);
  });

  it('parses cleanly', () => {
    expect(warnings).toEqual([]);
  });
});

describe('new-format section', () => {
  const bytes = buildNested95a();
  const { document, warnings } = parseUhs(bytes);

  it('takes the game title from the root subject label (the key seed)', () => {
    expect(document.game.title).toBe(NESTED_95A.title);
  });

  it('prefers the new format over the 88a decoy tree', () => {
    expect(document.root.children.some((c) => c.label === NESTED_95A.chapterLabel)).toBe(true);
  });

  it('still exposes the 88a decoy on request', () => {
    const legacy = parseUhs(bytes, { prefer88a: true });
    expect(legacy.document.root.children[0]?.label).toBe('Upgrade required');
  });

  it('splits hint hunks on the "-" separator', () => {
    const group = find<HintGroupNode>(document.root, 'hints', NESTED_95A.hint.label);
    expect(group.hints).toHaveLength(NESTED_95A.hint.hints.length);
    expect(inlineText(group.hints[1]!.content)).toBe(NESTED_95A.hint.hints[1]!.join('\n'));
  });

  it('decrypts nesthint bodies with key cipher variant 1', () => {
    const group = find<HintGroupNode>(document.root, 'hints', NESTED_95A.nesthint.label);
    expect(inlineText(group.hints[0]!.content)).toBe(NESTED_95A.nesthint.first.join('\n'));
    expect(inlineText(group.hints[1]!.content)).toBe(NESTED_95A.nesthint.second.join('\n'));
  });

  it('attaches "=" hunks to the hint they appear in', () => {
    const group = find<HintGroupNode>(document.root, 'hints', NESTED_95A.nesthint.label);
    const nested = group.hints[0]!.nested;
    expect(nested).toHaveLength(1);
    const inner = find<HintGroupNode>(nested![0]!, 'hints', NESTED_95A.nesthint.nestedLabel);
    expect(inlineText(inner.hints[0]!.content)).toBe(NESTED_95A.nesthint.nestedHints[0]);
    expect(group.hints[1]!.nested).toBeUndefined();
  });

  it('decrypts text hunks with key cipher variant 2 from a byte offset', () => {
    const text = find<TextNode>(document.root, 'text', NESTED_95A.text.label);
    expect(inlineText(text.content)).toBe(NESTED_95A.text.body.join('\n'));
  });

  it('resolves link destinations to node ids', () => {
    const link = find<{ type: 'link'; label: string; targetId: string }>(
      document.root,
      'link',
      NESTED_95A.linkLabel,
    );
    const chapter = find<SubjectNode>(document.root, 'subject', NESTED_95A.chapterLabel);
    expect(link.targetId).toBe(chapter.id);
  });

  it('keeps plaintext version and info hunks', () => {
    expect(inlineText(find<TextNode>(document.root, 'text', 'Version').content)).toBe(
      NESTED_95A.version,
    );
    expect(inlineText(find<TextNode>(document.root, 'text', 'File information').content)).toBe(
      `Copyright: ${NESTED_95A.copyright}`,
    );
  });

  it('skips an unknown hunk by its declared line count and warns', () => {
    expect(warnings).toContain(
      `Unknown hunk type "${NESTED_95A.unknownHunkType}" at line 32; skipped 3 lines.`,
    );
    // The skip must not swallow or corrupt anything that follows it.
    for (const node of walk(document.root)) {
      expect('label' in node && node.label).not.toBe('and this line must both be skipped');
    }
  });

  it('warns about a zero checksum without failing', () => {
    expect(warnings.some((w) => w.includes('Checksum is zero'))).toBe(true);
    expect(document.root.children.length).toBeGreaterThan(0);
  });
});

describe('hyperpng', () => {
  const { document, warnings } = parseUhs(buildImage96a());
  const image = find<ImageNode>(document.root, 'image', IMAGE_96A.imageLabel);

  it('extracts the embedded PNG bytes verbatim', () => {
    expect([...image.data]).toEqual([...TINY_PNG]);
    expect(image.mime).toBe('image/png');
  });

  it('reads hotspot rectangles and their link targets', () => {
    expect(image.hotspots).toHaveLength(1);
    const hotspot = image.hotspots![0]!;
    expect(hotspot.rect).toEqual(IMAGE_96A.rect);
    expect(hotspot.target.label).toBe(IMAGE_96A.hotspotLabel);
    const target = find<HintGroupNode>(document.root, 'hints', IMAGE_96A.targetLabel);
    expect(hotspot.target.targetId).toBe(target.id);
  });

  it('parses cleanly', () => {
    expect(warnings).toEqual([]);
  });
});

describe('robustness', () => {
  it('never throws on truncated input', () => {
    const full = buildNested95a();
    for (const length of [0, 1, 5, 40, 120, full.length - 3]) {
      expect(() => parseUhs(full.slice(0, length))).not.toThrow();
    }
  });

  it('never throws on random bytes', () => {
    const noise = new Uint8Array(512);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) % 256;
    const result = parseUhs(noise);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reports a locator that points outside the file', () => {
    const bytes = buildNested95a();
    // Patch the locator in place, byte for byte. (Note: TextDecoder('latin1')
    // is a WHATWG alias for windows-1252 and silently rewrites 0x80-0x9F, so it
    // must never be used to round-trip UHS bytes — hence asciiDecode.)
    const asText = asciiDecode(bytes);
    const at = asText.search(/0 0 \d{8} \d{8}/);
    expect(at).toBeGreaterThan(0);
    const replacement = '0 0 99999999 00000010';
    const broken = Uint8Array.from(bytes);
    for (let i = 0; i < replacement.length; i++) {
      broken[at + i] = replacement.charCodeAt(i);
    }

    const result = parseUhs(broken);
    expect(result.warnings.some((w) => w.includes('points outside the file'))).toBe(true);
    // The bad hunk is dropped, but everything after it still parses.
    expect(
      [...walk(result.document.root)].some((n) => n.type === 'link'),
    ).toBe(true);
  });
});

describe('incentive gating (spec §11)', () => {
  const bytes = buildNested95a();

  it('does not decrypt registration-gated hints by default', () => {
    const { document } = parseUhs(bytes);
    const node = find<TextNode>(document.root, 'text', 'Registration-gated hints');
    const shown = inlineText(node.content);
    expect(shown).toContain('Settings');
    expect(shown).not.toContain(NESTED_95A.incentivePayload);
  });

  it('decrypts them only when the setting is enabled', () => {
    const { document } = parseUhs(bytes, { decodeIncentive: true });
    const node = find<TextNode>(document.root, 'text', 'Registration-gated hints');
    expect(inlineText(node.content)).toBe(NESTED_95A.incentivePayload);
  });

  it('marks UHS documents as personal-use-only', () => {
    expect(parseUhs(bytes).document.source.personalUseOnly).toBe(true);
    expect(parseUhs(bytes).document.source.license).toBe('proprietary-personal-use');
  });
});
