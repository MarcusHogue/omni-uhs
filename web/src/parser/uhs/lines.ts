/**
 * Container-level structure of a .uhs file.
 *
 * A UHS file has two halves. The first is DOS text (CRLF, 8-bit) and is
 * terminated by a 0x1A DOS EOF byte; the second is a raw binary blob holding
 * PNG/GIF/sound payloads. Hunk sizes and `link` destinations are *line*
 * numbers into the first half; `text`/`hyperpng`/`sound` locators are
 * *absolute byte offsets* into the whole file. Both coordinate systems have to
 * stay available, so we keep the original buffer alongside the line index.
 */

import { bytesEqualAscii } from './cp437.js';

export const END_88A = '** END OF 88A FORMAT **';

export interface UhsContainer {
  /** The entire file, untouched. Byte-offset payloads index into this. */
  raw: Uint8Array;
  /** Offset of the 0x1A DOS EOF marker, or raw.length when absent. */
  textEnd: number;
  /**
   * The text section split on LF with all CR bytes removed. Line number N
   * (1-based, as the format counts them) is `lines[N - 1]`.
   */
  lines: Uint8Array[];
  /** Index in `lines` of the END-OF-88A marker, or -1 for a pure 88a file. */
  end88Index: number;
  /** Trailing 16-bit value, little-endian. Informational only. */
  crc: number | null;
  warnings: string[];
}

/**
 * Split the text section into lines.
 *
 * CR bytes are dropped wherever they appear and LF terminates a line, matching
 * the reference implementation. A trailing LF therefore yields a final empty
 * line — that empty line is real as far as the format's line numbering is
 * concerned, so it must be kept.
 */
function splitLines(buf: Uint8Array, end: number): Uint8Array[] {
  const lines: Uint8Array[] = [];
  const current: number[] = [];
  for (let i = 0; i < end; i++) {
    const b = buf[i]!;
    if (b === 0x0d) continue;
    if (b === 0x0a) {
      lines.push(Uint8Array.from(current));
      current.length = 0;
      continue;
    }
    current.push(b);
  }
  lines.push(Uint8Array.from(current));
  return lines;
}

/**
 * Sum of every byte except the trailing two, mod 2^16. Informational only.
 *
 * The official checksum algorithm is undocumented and this is *not* it — it was
 * checked against real files (adv660, zork1, myst) along with every common
 * CRC-16 parameterization and a plain byte sum, and none reproduce the stored
 * value. So the reader never claims a mismatch: it would be wrong on every
 * genuine file. Only the deliberate zero written by unofficial authoring tools
 * is reported, and even that is a warning, never a failure.
 */
export function computeChecksum(raw: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < raw.length - 2; i++) sum += raw[i]!;
  return sum & 0xffff;
}

export function readContainer(raw: Uint8Array): UhsContainer {
  const warnings: string[] = [];

  let textEnd = raw.indexOf(0x1a);
  if (textEnd === -1) textEnd = raw.length;

  const lines = splitLines(raw, textEnd);

  let end88Index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (bytesEqualAscii(lines[i]!, END_88A)) {
      end88Index = i;
      break;
    }
  }

  let crc: number | null = null;
  if (raw.length >= 2) {
    crc = raw[raw.length - 2]! | (raw[raw.length - 1]! << 8);
    if (crc === 0) {
      warnings.push(
        'Checksum is zero — file was written by an unofficial authoring tool. Reading anyway.',
      );
    }
  }

  return { raw, textEnd, lines, end88Index, crc, warnings };
}
