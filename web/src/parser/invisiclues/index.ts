/**
 * InvisiClues and plain-text hint files from the IF Archive.
 *
 * The format is already question -> progressively-revealing answers, which is
 * exactly the AST's shape:
 *
 *     Section Name
 *     ************
 *
 *     How do I get past the guard?
 *       A. Something in the building might help.
 *       B. It's in a desk.
 *       C. Open the clerk's desk and take the letter.
 *
 * A line underlined with asterisks starts a section; an unindented line starts
 * a question; `A.`/`B.`/… start successive hints, each of which stays hidden
 * until the previous one is revealed.
 *
 * Input is a decoded string rather than bytes: unlike UHS, these files have no
 * cipher, and the encoding decision (UTF-8, falling back to Latin-1) belongs to
 * the caller.
 */

import type { HintDocument, HintGroupNode, HintNode, ParseResult, SubjectNode, TextNode } from '../ast';
import { stableId } from '../id';

export interface InvisicluesOptions {
  url?: string;
  title?: string;
  fetchedAt?: string;
}

const UNDERLINE = /^[*=~-]{3,}$/;
const ANSWER = /^\s+([A-Z])[.)]\s?(.*)$/;
const CONTINUATION = /^\s{2,}(\S.*)$/;
const BANNER = /^\*{10,}$/;

/**
 * These files open with a box-drawn title:
 *
 *     ***********************
 *     *      ZORK(R) I      *
 *     ***********************
 *
 * The middle line sits directly above a row of asterisks, so the heading rule
 * would happily turn the box into a section. Anything fenced by the box
 * characters is title art, not a heading.
 */
function isBoxArt(line: string): boolean {
  const trimmed = line.trim();
  return /^[*=~|-]/.test(trimmed) || /[*=~|-]$/.test(trimmed);
}

interface Builder {
  section: SubjectNode | null;
  group: HintGroupNode | null;
  hint: string[] | null;
}

const runs = (lines: string[]): HintNode['content'] => {
  const text = lines.join('\n').trim();
  return text ? [{ kind: 'run', text }] : [];
};

export function parseInvisiclues(text: string, options: InvisicluesOptions = {}): ParseResult {
  const warnings: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const root: SubjectNode = {
    id: 'p:0',
    type: 'subject',
    label: options.title ?? 'Hints',
    children: [],
  };

  // Everything before the first section heading is front matter: the banner,
  // the copyright note, and often a sample question.
  const preamble: string[] = [];
  const state: Builder = { section: null, group: null, hint: null };
  let counter = 0;
  const nextId = (): string => `p:${++counter}`;

  const closeHint = (): void => {
    if (state.group && state.hint && state.hint.join('').trim() !== '') {
      state.group.hints.push({
        id: `${state.group.id}:h${state.group.hints.length}`,
        type: 'hint',
        content: runs(state.hint),
      });
    }
    state.hint = null;
  };

  const closeGroup = (): void => {
    closeHint();
    if (state.group && state.section) {
      if (state.group.hints.length > 0) {
        state.section.children.push(state.group);
      } else {
        // A heading with no answers is prose, not a hint group.
        const note: TextNode = {
          id: state.group.id ?? nextId(),
          type: 'text',
          label: state.group.label,
          content: [],
        };
        state.section.children.push(note);
      }
    }
    state.group = null;
  };

  const closeSection = (): void => {
    closeGroup();
    if (state.section && state.section.children.length > 0) {
      root.children.push(state.section);
    }
    state.section = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];

    // A heading is a non-empty line underlined with punctuation.
    if (
      line.trim() !== '' &&
      !BANNER.test(line.trim()) &&
      !isBoxArt(line) &&
      next !== undefined &&
      UNDERLINE.test(next.trim()) &&
      next.trim().length >= Math.min(3, line.trim().length)
    ) {
      closeSection();
      state.section = { id: nextId(), type: 'subject', label: line.trim(), children: [] };
      i += 1;
      continue;
    }

    if (state.section === null) {
      if (line.trim() !== '' && !BANNER.test(line.trim())) preamble.push(line.trim());
      continue;
    }

    // "  A. text" — one of a lettered, progressively-revealed series.
    const answer = ANSWER.exec(line);
    if (answer) {
      closeHint();
      state.hint = [answer[2] ?? ''];
      continue;
    }

    if (line.trim() === '') {
      // A blank line ends the question only if what follows starts a new one.
      // Inside an answer it is just a paragraph break, and treating it as a
      // terminator would split one answer into several "hints".
      const following = lines.slice(i + 1).find((l) => l.trim() !== '');
      const nextStartsQuestion = following !== undefined && !/^\s/.test(following);
      if (nextStartsQuestion) closeGroup();
      else if (state.hint) state.hint.push('');
      continue;
    }

    if (/^\s/.test(line)) {
      const body = CONTINUATION.exec(line)?.[1] ?? line.trim();
      if (state.hint) {
        state.hint.push(body);
      } else if (state.group) {
        // An indented block with no letter: a single, unlettered answer. Common
        // for one-line replies ("Play ZORK II.").
        state.hint = [body];
      }
      continue;
    }

    // Column zero: a new question, or the wrapped remainder of the last one.
    if (state.group && state.group.hints.length === 0 && state.hint === null) {
      state.group.label = `${state.group.label} ${line.trim()}`.trim();
    } else {
      closeGroup();
      state.group = { id: nextId(), type: 'hints', label: line.trim(), hints: [] };
    }
  }
  closeSection();

  // Warn on the section count *before* the front matter is added: a file whose
  // structure we did not understand still shows its text, but the user should
  // be told that is all they are getting.
  if (root.children.length === 0) {
    warnings.push('No hint sections were recognised in this file.');
  }

  if (preamble.length > 0) {
    root.children.unshift({
      id: 'p:about',
      type: 'text',
      label: 'About this file',
      content: [{ kind: 'run', text: preamble.join('\n') }],
    });
  }

  const url = options.url ?? '';
  const document: HintDocument = {
    id: stableId('ifarchive', url || root.label),
    game: { title: options.title ?? root.label },
    source: {
      kind: 'ifarchive',
      url,
      // IF Archive hint files carry their own licences; most InvisiClues
      // transcriptions are explicitly non-commercial, so never export them.
      license: 'see-file-notice',
      personalUseOnly: true,
    },
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    root,
  };

  return { document, warnings };
}
