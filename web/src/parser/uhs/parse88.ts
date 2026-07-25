/**
 * The 88a section.
 *
 * Layout: a four-line header (`UHS`, title, first-hint line, last-hint line)
 * followed by a flat run of two-line "links" and then the hint lines.
 *
 * Every stored line number ignores the four-line header, so an index into the
 * post-header array is `value - 1` (equivalently, the physical file line is
 * `value + 4`). Three levels come out of that flat list:
 *
 *   subject links  ->  question links  ->  hint lines
 *
 * Each link is two lines: an encrypted label and a destination line number.
 * A hint is a single encrypted line.
 *
 * In modern files this section is only a decoy tree telling 1988-era readers to
 * upgrade, but it is also the whole document for genuine 88a files, so it is
 * parsed properly either way.
 */

import type { HintGroupNode, HintNode, SubjectNode } from '../ast.js';
import { decode88 } from './cipher.js';
import { asciiDecode, cp437Decode } from './cp437.js';
import type { UhsContainer } from './lines.js';
import { tokenizeMarkup } from './markup.js';

export interface Parsed88 {
  title: string;
  root: SubjectNode;
}

function decodeLabel(line: Uint8Array | undefined): string {
  if (!line) return '';
  return cp437Decode(decode88(line));
}

function parseLineNumber(line: Uint8Array | undefined): number | null {
  if (!line) return null;
  const value = Number.parseInt(asciiDecode(line).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse the 88a section. Returns null when the section is too malformed to be
 * useful (a warning is recorded); callers fall back to the new-format tree.
 */
export function parse88(
  container: UhsContainer,
  warnings: string[],
): Parsed88 | null {
  const all = container.lines;
  const limit = container.end88Index === -1 ? all.length : container.end88Index;
  const lines = all.slice(0, limit);

  if (lines.length < 6) {
    warnings.push('88a section is too short to parse.');
    return null;
  }

  const title = cp437Decode(lines[1]!).trim();
  // Read the header-relative pointers *before* dropping the header.
  const lastHint = parseLineNumber(lines[3]);
  const firstQuestion = parseLineNumber(lines[5]);
  const body = lines.slice(4);

  if (lastHint === null || firstQuestion === null) {
    warnings.push('88a header does not contain valid line numbers.');
    return null;
  }

  const subjectEnd = firstQuestion - 1; // first index past the subject links
  const hintEnd = lastHint - 1; // index of the final hint line

  const children: SubjectNode[] = [];

  for (let s = 0; s + 1 < subjectEnd && s + 1 < body.length; s += 2) {
    const questionStart = parseLineNumber(body[s + 1]);
    if (questionStart === null) {
      warnings.push(`88a subject link at line ${s + 5} has no destination.`);
      continue;
    }
    // The next subject's destination bounds this subject's questions; for the
    // last subject that slot holds the first question's hint pointer, which is
    // exactly where the question links stop.
    const nextStart = parseLineNumber(body[s + 3]);
    if (nextStart === null) {
      warnings.push(`88a subject link at line ${s + 5} has no terminator.`);
      continue;
    }

    const subject: SubjectNode = {
      id: `uhs88:${s + 1}`,
      type: 'subject',
      label: decodeLabel(body[s]),
      children: [],
    };

    const fq = questionStart - 1;
    const nq = nextStart - 1;

    for (let q = fq; q + 1 < nq && q + 1 < body.length; q += 2) {
      const hintStart = parseLineNumber(body[q + 1]);
      if (hintStart === null) continue;
      const isLastQuestion = s + 2 >= subjectEnd && q + 2 >= nq;
      const nextHintStart = isLastQuestion ? hintEnd + 2 : parseLineNumber(body[q + 3]);
      if (nextHintStart === null) continue;

      const fh = hintStart - 1;
      const lh = Math.min(nextHintStart - 1, body.length);

      const hints: HintNode[] = [];
      for (let h = fh; h < lh; h++) {
        const raw = body[h];
        if (!raw) continue;
        const text = cp437Decode(decode88(raw));
        hints.push({ id: `uhs88:${h + 1}`, type: 'hint', content: tokenizeMarkup(text) });
      }

      const group: HintGroupNode = {
        id: `uhs88:${q + 1}`,
        type: 'hints',
        label: decodeLabel(body[q]),
        hints,
      };
      subject.children.push(group);
    }

    children.push(subject);
  }

  if (children.length === 0) {
    warnings.push('88a section contained no readable subjects.');
    return null;
  }

  return {
    title,
    root: { id: 'uhs88:0', type: 'subject', label: title, children },
  };
}
