/**
 * Synthetic UHS fixtures.
 *
 * Real hint files are copyrighted and must never enter the repository (spec
 * §10/§11), so the committed fixture suite is hand-authored here: every byte is
 * ours, and the plaintext is exported so tests can assert against the *intent*
 * rather than against a snapshot of the parser's own output.
 *
 * The builder emits `<name>.uhs` plus `<name>.expected.json`. The Swift parser
 * will later be held to the same pair.
 */

import { makeKey } from '../../src/parser/uhs/cipher.js';
import { cp437Encode } from '../../src/parser/uhs/cp437.js';
import { encode88, encodeKey } from '../uhs-encode.js';

export const END_88A = '** END OF 88A FORMAT **';

/** Zero-padded so patching real byte offsets in later never shifts a line. */
const WIDTH = 8;
const pad = (n: number): string => String(n).padStart(WIDTH, '0');

/** A 1x1 transparent PNG — the smallest legal image we can embed. */
export const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

/**
 * A line of the text section. Payload lines carry a placeholder locator that is
 * patched with the real absolute byte offset once the text section's length is
 * known.
 */
type Line =
  | { kind: 'literal'; text: string }
  | { kind: 'raw'; bytes: Uint8Array }
  | { kind: 'locator'; prefix: string; payload: Uint8Array; length: number };

class Builder {
  readonly lines: Line[] = [];
  readonly payloads: { payload: Uint8Array; lineIndex: number }[] = [];

  literal(text: string): this {
    this.lines.push({ kind: 'literal', text });
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.lines.push({ kind: 'raw', bytes });
    return this;
  }

  /** `prefix` is the leading fixed fields, e.g. "0 0" for text, "0" for hyperpng. */
  locator(prefix: string, payload: Uint8Array): this {
    this.payloads.push({ payload, lineIndex: this.lines.length });
    this.lines.push({ kind: 'locator', prefix, payload, length: payload.length });
    return this;
  }

  /** Current 1-based line number of the next line to be added. */
  get nextLine(): number {
    return this.lines.length + 1;
  }

  build(crc: number | 'auto'): Uint8Array {
    // Pass 1: render with placeholder offsets to measure the text section.
    const render = (offsets: Map<number, number>): Uint8Array => {
      const chunks: Uint8Array[] = [];
      this.lines.forEach((line, index) => {
        if (line.kind === 'literal') chunks.push(cp437Encode(line.text));
        else if (line.kind === 'raw') chunks.push(line.bytes);
        else {
          const offset = offsets.get(index) ?? 0;
          chunks.push(
            cp437Encode(`${line.prefix} ${pad(offset)} ${pad(line.length)}`),
          );
        }
        chunks.push(Uint8Array.from([0x0d, 0x0a]));
      });
      return concat(chunks);
    };

    const placeholder = render(new Map());
    // 0x1A terminates the text section; payloads follow it back to back.
    const binaryStart = placeholder.length + 1;
    const offsets = new Map<number, number>();
    let cursor = binaryStart;
    for (const { payload, lineIndex } of this.payloads) {
      offsets.set(lineIndex, cursor);
      cursor += payload.length;
    }

    const textSection = render(offsets);
    if (textSection.length !== placeholder.length) {
      throw new Error('locator patching changed the text section length');
    }

    const body = concat([
      textSection,
      Uint8Array.from([0x1a]),
      ...this.payloads.map((p) => p.payload),
    ]);

    const withCrc = new Uint8Array(body.length + 2);
    withCrc.set(body, 0);
    let value = 0;
    if (crc === 'auto') {
      let sum = 0;
      for (let i = 0; i < body.length; i++) sum += body[i]!;
      value = sum & 0xffff;
    }
    withCrc[body.length] = value & 0xff;
    withCrc[body.length + 1] = (value >> 8) & 0xff;
    return withCrc;
  }
}

/**
 * Encrypt a `text` payload.
 *
 * The line breaks inside a payload blob are literal CRLF bytes; each line is
 * encrypted independently, so the cipher's position counter restarts on every
 * line. Getting this wrong is invisible on line one and garbage from line two
 * onwards.
 */
function encodeKeyLines(lines: string[], key: Uint8Array, variant: 1 | 2): Uint8Array {
  const chunks: Uint8Array[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(Uint8Array.from([0x0d, 0x0a]));
    chunks.push(encodeKey(line, key, variant));
  });
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture 1: pure 88a
// ---------------------------------------------------------------------------

export const TINY_88A = {
  title: 'Cave of Tests',
  subjects: [
    {
      label: 'Chapter One',
      questions: [
        {
          label: 'How do I open the door?',
          hints: ['Have you tried the handle?', 'The handle is stuck; oil it.'],
        },
        { label: 'Where is the key?', hints: ['Under the mat.'] },
      ],
    },
    {
      label: 'Chapter Two',
      questions: [{ label: 'What now?', hints: ['Go north twice.'] }],
    },
  ],
};

/**
 * 88a layout, all line numbers relative to the end of the four-line header:
 *
 *   subject links (2 lines each) | question links (2 lines each) | hint lines
 */
export function buildTiny88a(): Uint8Array {
  const subjects = TINY_88A.subjects;
  const questions = subjects.flatMap((s) => s.questions);

  const subjectLines = subjects.length * 2;
  const questionLines = questions.length * 2;
  const firstQuestion = subjectLines + 1;
  const firstHint = subjectLines + questionLines + 1;

  // Where each question's hints start.
  const hintStarts: number[] = [];
  let cursor = firstHint;
  for (const q of questions) {
    hintStarts.push(cursor);
    cursor += q.hints.length;
  }
  const lastHint = cursor - 1;

  const b = new Builder();
  b.literal('UHS');
  b.literal(TINY_88A.title);
  b.literal(String(firstHint));
  b.literal(String(lastHint));

  // Subject links: each points at the first of its own question links.
  let questionCursor = firstQuestion;
  for (const subject of subjects) {
    b.raw(encode88(subject.label));
    b.literal(String(questionCursor));
    questionCursor += subject.questions.length * 2;
  }

  // Question links: each points at its first hint line.
  questions.forEach((question, index) => {
    b.raw(encode88(question.label));
    b.literal(String(hintStarts[index]!));
  });

  for (const question of questions) {
    for (const hint of question.hints) b.raw(encode88(hint));
  }

  return b.build('auto');
}

// ---------------------------------------------------------------------------
// Fixture 2: 95a — hunks, both key-cipher variants, an unknown hunk
// ---------------------------------------------------------------------------

export const NESTED_95A = {
  title: 'The Nested Grotto',
  version: '95a',
  copyright: 'Synthetic fixture, written for this repository.',
  chapterLabel: 'Chapter One',
  hint: {
    label: 'How do I cross the chasm?',
    hints: [['Look for a bridge.'], ['The bridge is invisible.', 'Throw sand on it.']],
  },
  nesthint: {
    label: 'What about the guardian?',
    first: ['It only sleeps at noon.'],
    nestedLabel: 'Show me the exact time',
    nestedHints: ['Wait until the sundial reads XII.'],
    second: ['Then walk straight past it.'],
  },
  text: {
    label: 'Map notes',
    body: ['The grotto has three levels.', 'Only the middle one matters.'],
  },
  linkLabel: 'Back to Chapter One',
  unknownHunkType: 'mystery',
  /** Real files label this hunk "-" and store a list of gated hint offsets. */
  incentivePayload: '3Z 903A 962A',
};

export function buildNested95a(): Uint8Array {
  const b = new Builder();
  const d = NESTED_95A;

  // -- 88a decoy section ---------------------------------------------------
  // Modern files keep a minimal 88a tree telling old readers to upgrade.
  const notice = 'This file requires a 95a-capable reader.';
  b.literal('UHS');
  b.literal(d.title);
  b.literal('5');
  b.literal('5');
  b.raw(encode88('Upgrade required'));
  b.literal('3');
  b.raw(encode88('Please upgrade'));
  b.literal('5');
  b.raw(encode88(notice));
  b.literal(END_88A);

  // -- new format ----------------------------------------------------------
  // Line numbering restarts at 1 on the line after the marker. The cipher key
  // is seeded from the root subject's label, i.e. the game title.
  const key = makeKey(cp437Encode(d.title));

  // Precompute sizes bottom-up so the root's line count is exact.
  const versionHunk = ['2 version', d.version];
  const infoHunk = ['3 info', 'info', `copyright=${d.copyright}`];

  const hintBody: string[] = [];
  d.hint.hints.forEach((group, index) => {
    if (index > 0) hintBody.push('-');
    hintBody.push(...group);
  });

  // Nested hunk inside the nesthint: a plain hint group.
  const nestedInner = [
    `${2 + d.nesthint.nestedHints.length} hint`,
    d.nesthint.nestedLabel,
    ...d.nesthint.nestedHints,
  ];

  const nesthintBodyLength =
    d.nesthint.first.length + 1 + nestedInner.length + 1 + d.nesthint.second.length;

  const chapterChildrenLength =
    2 + hintBody.length + (2 + nesthintBodyLength) + 3 + 3;
  const chapterLength = 2 + chapterChildrenLength;
  const rootLength =
    2 + versionHunk.length + infoHunk.length + chapterLength + 1 + 3 + 3;

  // Absolute new-format line numbers, computed as we go.
  let n = 1;
  const emitLiteral = (text: string): number => {
    b.literal(text);
    return n++;
  };
  const emitRaw = (bytes: Uint8Array): number => {
    b.raw(bytes);
    return n++;
  };

  emitLiteral(`${rootLength} subject`);
  emitLiteral(d.title);
  versionHunk.forEach(emitLiteral);
  infoHunk.forEach(emitLiteral);

  const chapterLine = n;
  emitLiteral(`${chapterLength} subject`);
  emitLiteral(d.chapterLabel);

  emitLiteral(`${2 + hintBody.length} hint`);
  emitLiteral(d.hint.label);
  for (const text of hintBody) {
    if (text === '-') emitLiteral('-');
    else emitRaw(encode88(text));
  }

  emitLiteral(`${2 + nesthintBodyLength} nesthint`);
  emitLiteral(d.nesthint.label);
  for (const text of d.nesthint.first) emitRaw(encodeKey(text, key, 1));
  emitLiteral('=');
  nestedInner.forEach((text, index) => {
    if (index < 2) emitLiteral(text);
    else emitRaw(encode88(text));
  });
  emitLiteral('-');
  for (const text of d.nesthint.second) emitRaw(encodeKey(text, key, 1));

  emitLiteral('3 text');
  emitLiteral(d.text.label);
  b.locator('0 0', encodeKeyLines(d.text.body, key, 2));
  n++;

  emitLiteral('3 link');
  emitLiteral(d.linkLabel);
  emitLiteral(String(chapterLine));

  emitLiteral('1 blank');

  // Forward compatibility: an unknown hunk must be skipped by its line count.
  emitLiteral(`3 ${d.unknownHunkType}`);
  emitLiteral('this label');
  emitLiteral('and this line must both be skipped');

  // Registration-gated hints; stays encrypted unless the user opts in (§11).
  emitLiteral('3 incentive');
  emitLiteral('-');
  emitRaw(encodeKey(d.incentivePayload, key, 1));

  if (n - 1 !== rootLength) {
    throw new Error(`95a fixture: emitted ${n - 1} lines, declared ${rootLength}`);
  }

  // Unofficial tools write a zero checksum on purpose; exercise that path.
  return b.build(0);
}

// ---------------------------------------------------------------------------
// Fixture 3: 96a — hyperpng with hotspots
// ---------------------------------------------------------------------------

export const IMAGE_96A = {
  title: 'The Illustrated Cavern',
  imageLabel: 'Map of the cavern',
  hotspotLabel: 'The north passage',
  targetLabel: 'North passage',
  targetHints: ['It is blocked by rubble.', 'Use the pickaxe from the shed.'],
  rect: [10, 20, 90, 60] as [number, number, number, number],
};

export function buildImage96a(): Uint8Array {
  const b = new Builder();
  const d = IMAGE_96A;

  b.literal('UHS');
  b.literal(d.title);
  b.literal('5');
  b.literal('5');
  b.raw(encode88('Upgrade required'));
  b.literal('3');
  b.raw(encode88('Please upgrade'));
  b.literal('5');
  b.raw(encode88('This file requires a 96a-capable reader.'));
  b.literal(END_88A);

  // 2 header lines + one line per hint + a '-' separator between hints.
  const targetLength = 2 + d.targetHints.length + (d.targetHints.length - 1);
  const hotspotHunkLength = 3; // "3 link", label, destination
  const imageLength = 3 + 1 + hotspotHunkLength;
  const rootLength = 2 + imageLength + targetLength;

  let n = 1;
  const emitLiteral = (text: string): number => {
    b.literal(text);
    return n++;
  };

  emitLiteral(`${rootLength} subject`);
  emitLiteral(d.title);

  emitLiteral(`${imageLength} hyperpng`);
  emitLiteral(d.imageLabel);
  b.locator('0', TINY_PNG);
  n++;
  emitLiteral(d.rect.join(' '));
  emitLiteral('3 link');
  emitLiteral(d.hotspotLabel);
  const targetLine = n + 1;
  emitLiteral(String(targetLine));

  if (n !== targetLine) throw new Error('96a fixture: link target miscomputed');
  emitLiteral(`${targetLength} hint`);
  emitLiteral(d.targetLabel);
  d.targetHints.forEach((hint, index) => {
    if (index > 0) emitLiteral('-');
    b.raw(encode88(hint));
    n++;
  });

  if (n - 1 !== rootLength) {
    throw new Error(`96a fixture: emitted ${n - 1} lines, declared ${rootLength}`);
  }

  return b.build('auto');
}

export const FIXTURES: { name: string; build: () => Uint8Array }[] = [
  { name: 'tiny88a', build: buildTiny88a },
  { name: 'nested95a', build: buildNested95a },
  { name: 'image96a', build: buildImage96a },
];
