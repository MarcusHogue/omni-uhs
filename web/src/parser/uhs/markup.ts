/**
 * UHS inline markup.
 *
 * Inside a decrypted string, `#` is the escape character. `##` is a literal
 * `#`; otherwise `#` is followed by exactly two characters forming a token:
 *
 *   #p+  proportional font (monospace off)
 *   #p-  monospace font
 *   #w+  honour whitespace
 *   #w-  collapse whitespace
 *
 * Unknown two-character tokens are consumed and rendered as no-ops — the
 * format has to stay forward-compatible, and a stray token must never leak
 * into displayed text.
 */

import type { Inline } from '../ast.js';

export interface MarkupState {
  mono: boolean;
}

export interface TokenizeOptions {
  /** Carried across the lines of a multi-line hunk. */
  state?: MarkupState;
  /** Unknown tokens are reported here rather than thrown. */
  onUnknownToken?: (token: string) => void;
}

/**
 * Convert one decrypted, CP437-decoded string into inline runs.
 *
 * `state` is mutated so a caller can thread font state across the lines of a
 * single hunk, which is how the format uses it.
 */
export function tokenizeMarkup(
  text: string,
  options: TokenizeOptions = {},
): Inline[] {
  const state = options.state ?? { mono: false };
  const out: Inline[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer === '') return;
    out.push(
      state.mono ? { kind: 'run', text: buffer, mono: true } : { kind: 'run', text: buffer },
    );
    buffer = '';
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch !== '#') {
      buffer += ch;
      i += 1;
      continue;
    }
    if (text[i + 1] === '#') {
      buffer += '#';
      i += 2;
      continue;
    }
    const token = text.slice(i + 1, i + 3);
    if (token.length < 2) {
      // Dangling '#' at end of line: emit it literally rather than losing it.
      buffer += '#';
      i += 1;
      continue;
    }
    switch (token) {
      case 'p+':
        flush();
        state.mono = false;
        break;
      case 'p-':
        flush();
        state.mono = true;
        break;
      case 'w+':
      case 'w-':
        // Whitespace handling is a rendering concern; the reader always
        // preserves the source line structure, so these are no-ops.
        break;
      default:
        options.onUnknownToken?.(token);
        break;
    }
    i += 3;
  }

  flush();
  return out;
}

/**
 * Tokenize a block of lines into a single inline sequence, preserving line
 * breaks and font state across lines.
 */
export function tokenizeBlock(
  lines: string[],
  options: TokenizeOptions = {},
): Inline[] {
  const state = options.state ?? { mono: false };
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    const opts: TokenizeOptions = { state };
    if (options.onUnknownToken) opts.onUnknownToken = options.onUnknownToken;
    out.push(...tokenizeMarkup(line, opts));
    if (index < lines.length - 1) {
      out.push(state.mono ? { kind: 'run', text: '\n', mono: true } : { kind: 'run', text: '\n' });
    }
  });
  return mergeRuns(out);
}

/** Collapse adjacent runs that share formatting. Keeps fixtures tidy. */
export function mergeRuns(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of inlines) {
    const prev = out[out.length - 1];
    if (
      item.kind === 'run' &&
      prev &&
      prev.kind === 'run' &&
      Boolean(prev.mono) === Boolean(item.mono)
    ) {
      out[out.length - 1] = prev.mono
        ? { kind: 'run', text: prev.text + item.text, mono: true }
        : { kind: 'run', text: prev.text + item.text };
      continue;
    }
    out.push(item);
  }
  return out;
}
