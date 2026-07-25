import { describe, expect, it } from 'vitest';

import { tokenizeBlock, tokenizeMarkup } from '../../src/parser/uhs/markup.js';

const plain = (text: string): string =>
  tokenizeMarkup(text)
    .map((i) => (i.kind === 'run' ? i.text : i.label))
    .join('');

describe('# markup', () => {
  it('leaves unmarked text alone', () => {
    expect(tokenizeMarkup('Just a hint.')).toEqual([
      { kind: 'run', text: 'Just a hint.' },
    ]);
  });

  it('unescapes ## to a literal #', () => {
    expect(plain('Room ##3')).toBe('Room #3');
  });

  it('switches to monospace on #p- and back on #p+', () => {
    expect(tokenizeMarkup('a#p-b#p+c')).toEqual([
      { kind: 'run', text: 'a' },
      { kind: 'run', text: 'b', mono: true },
      { kind: 'run', text: 'c' },
    ]);
  });

  it('treats whitespace toggles as no-ops', () => {
    expect(plain('one#w-two#w+three')).toBe('onetwothree');
  });

  it('consumes unknown tokens without leaking them into the text', () => {
    const seen: string[] = [];
    const out = tokenizeMarkup('before#zzafter', {
      onUnknownToken: (t) => seen.push(t),
    });
    expect(out).toEqual([{ kind: 'run', text: 'beforeafter' }]);
    expect(seen).toEqual(['zz']);
  });

  it('keeps a dangling # rather than dropping the character', () => {
    expect(plain('trailing#')).toBe('trailing#');
  });

  it('carries font state across the lines of a block', () => {
    expect(tokenizeBlock(['start#p-', 'still mono', '#p+done'])).toEqual([
      { kind: 'run', text: 'start' },
      { kind: 'run', text: '\nstill mono\n', mono: true },
      { kind: 'run', text: 'done' },
    ]);
  });

  it('merges adjacent runs with identical formatting', () => {
    expect(tokenizeBlock(['a', 'b'])).toEqual([{ kind: 'run', text: 'a\nb' }]);
  });
});
