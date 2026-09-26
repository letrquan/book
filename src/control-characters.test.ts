import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHARACTERS,
  escapeInvisibleCharacters,
  foldControlCharacters,
} from './control-characters.js';

const at = (code: number): string => String.fromCharCode(code);
/** The backslash a visible escape is spelled with, kept out of the literals below. */
const b = at(0x005c);

describe('foldControlCharacters', () => {
  it('folds a bidi override, a line separator and a newline to one space each', () => {
    const raw = ['a', at(0x202e), 'b', at(0x2028), 'c', '\n', 'd'].join('');
    expect(foldControlCharacters(raw)).toBe('a b c d');
  });

  it('keeps ordinary spaces, which are part of what the row shows', () => {
    expect(foldControlCharacters('^    def foo')).toBe('^    def foo');
  });
});

describe('escapeInvisibleCharacters', () => {
  it('names every invisible character the parser may have rejected', () => {
    const raw = [at(0x0000), at(0x001b), at(0x00a0), at(0xfeff), '\n', '\t'].join('');
    expect(escapeInvisibleCharacters(raw)).toBe(
      [`${b}u0000`, `${b}u001B`, `${b}u00A0`, `${b}uFEFF`, `${b}n`, `${b}t`].join(''),
    );
  });

  it('leaves ordinary text and its spaces alone', () => {
    expect(escapeInvisibleCharacters('a b')).toBe('a b');
  });
});

describe('CONTROL_CHARACTERS', () => {
  it('is a global pattern, so callers match rather than test', () => {
    // A `test` on a /g pattern advances `lastIndex` and answers differently next
    // time, which is why folding goes through `replace`.
    expect(['a', at(0x0000), 'b'].join('').match(CONTROL_CHARACTERS)).toEqual([at(0x0000)]);
  });
});
