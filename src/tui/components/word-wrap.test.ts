import { describe, expect, it } from 'vitest';
import { expandTabs } from '../../tab-stops.js';
import {
  wordWrap,
  hardWrap,
  hardWrapLine,
  displayWidth,
  fitsDisplayWidth,
  makeDivider,
  padDisplay,
  truncateDisplay,
} from './word-wrap.js';

describe('displayWidth', () => {
  it('returns 0 for empty string', () => {
    expect(displayWidth('')).toBe(0);
  });

  it('counts ASCII as 1 per char', () => {
    expect(displayWidth('hello')).toBe(5);
  });

  it('counts CJK characters as 2 per char', () => {
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('hello你好')).toBe(9); // 5 + 4
  });

  it('counts emoji as 2 per char', () => {
    expect(displayWidth('😀')).toBe(2);
    expect(displayWidth('hello 😀')).toBe(8); // 5 + 1(space) + 2
    expect(displayWidth('🎉🚀')).toBe(4);
  });

  it('counts zero-width characters as 0', () => {
    // ZWSP (U+200B)
    expect(displayWidth('hello​world')).toBe(10); // 5 + 5
    // ZWNJ (U+200C)
    expect(displayWidth('a‌b')).toBe(2);
    // ZWJ (U+200D)
    expect(displayWidth('a‍b')).toBe(2);
    // Variation selector (U+FE0F)
    expect(displayWidth('️')).toBe(0);
  });

  it('counts combining characters as 0', () => {
    // Combining grave accent (U+0300)
    expect(displayWidth('è')).toBe(1); // è = e + combining grave
    // Multiple combining marks
    expect(displayWidth('à́')).toBe(1);
  });

  it('handles mixed CJK, emoji, and ASCII', () => {
    // "你好" (4) + " " (1) + "😀" (2) + " " (1) + "world" (5) = 13
    expect(displayWidth('你好 😀 world')).toBe(13);
  });
});

describe('responsive width helpers', () => {
  it('makes dividers with padding and tiny-width clamp', () => {
    expect(makeDivider(80, 2)).toHaveLength(78);
    expect(makeDivider(3, 2)).toHaveLength(5);
    expect(makeDivider(10, 0, '═')).toBe('══════════');
  });

  it('detects display-width fits', () => {
    expect(fitsDisplayWidth('hello', 5)).toBe(true);
    expect(fitsDisplayWidth('hello', 4)).toBe(false);
    expect(fitsDisplayWidth('你好', 4)).toBe(true);
    expect(fitsDisplayWidth('你好', 3)).toBe(false);
  });

  it('truncates by display width with wide characters', () => {
    expect(truncateDisplay('hello world', 8)).toBe('hello w…');
    expect(displayWidth(truncateDisplay('hello 你好 world', 10))).toBeLessThanOrEqual(10);
    expect(truncateDisplay('你好世界', 5)).toBe('你好…');
  });

  it('handles tiny truncation budgets', () => {
    expect(truncateDisplay('hello', 0)).toBe('');
    expect(truncateDisplay('hello', 1)).toBe('…');
    expect(truncateDisplay('hello', 2)).toBe('h…');
  });
});

describe('wordWrap', () => {
  it('returns empty string for empty input', () => {
    expect(wordWrap('', 80)).toBe('');
  });

  it('returns text unchanged when it fits within maxWidth', () => {
    expect(wordWrap('hello world', 80)).toBe('hello world');
  });

  it('wraps at word boundary when text exceeds maxWidth', () => {
    // "hello world" = 11 chars, maxWidth=5 → should wrap after "hello"
    const result = wordWrap('hello world', 5);
    expect(result).toBe('hello\nworld');
  });

  it('wraps multiple lines', () => {
    const result = wordWrap('the quick brown fox jumps over the lazy dog', 10);
    // "the quick" = 9 chars, "brown fox" = 9 chars, etc.
    expect(result).toBe('the quick\nbrown fox\njumps over\nthe lazy\ndog');
  });

  it('preserves paragraph breaks (blank lines)', () => {
    const result = wordWrap('line one\n\nline two', 80);
    expect(result).toBe('line one\n\nline two');
  });

  it('preserves paragraph breaks with wrapping', () => {
    const result = wordWrap('short\n\nthis is a long paragraph that should wrap', 10);
    expect(result).toBe('short\n\nthis is a\nlong\nparagraph\nthat\nshould\nwrap');
  });

  it('hard-wraps long words that exceed maxWidth', () => {
    const result = wordWrap('supercalifragilisticexpialidocious', 10);
    const lines = result.split('\n');
    expect(lines.every((line) => displayWidth(line) <= 10)).toBe(true);
    expect(lines.join('')).toBe('supercalifragilisticexpialidocious');
  });

  it('wraps normally and hard-wraps a single long word on its own lines', () => {
    const result = wordWrap('hello supercalifragilisticexpialidocious world', 10);
    const lines = result.split('\n');
    expect(lines[0]).toBe('hello');
    expect(lines.every((line) => displayWidth(line) <= 10)).toBe(true);
    // Long token is hard-broken; last fragment may share a line with "world".
    expect(result.replace(/\s+/g, '')).toBe('hellosupercalifragilisticexpialidociousworld');
    expect(result).toContain('world');
  });

  it('handles maxWidth of 0 by returning text unchanged', () => {
    expect(wordWrap('hello world', 0)).toBe('hello world');
  });

  it('handles negative maxWidth by returning text unchanged', () => {
    expect(wordWrap('hello world', -1)).toBe('hello world');
  });

  it('preserves multiple spaces when text fits within maxWidth', () => {
    const result = wordWrap('hello   world', 80);
    // When text fits, it passes through unchanged (spaces included).
    expect(result).toBe('hello   world');
  });

  it('handles CJK characters (wide characters)', () => {
    // Each CJK char is ~2 wide, so "你好世界" = 8 cols in 10-col terminal
    const result = wordWrap('hello 你好 world', 10);
    // "hello" (5) + " " (1) + "你好" (4) = 10 → fits on one line
    expect(result).toBe('hello 你好\nworld');
  });

  it('handles text that exactly fits maxWidth', () => {
    const result = wordWrap('hello', 5);
    expect(result).toBe('hello');
  });

  it('handles emoji in text (emoji counted as 2-width)', () => {
    // "hello" (5) + " " (1) + "😀" (2) = 8, fits in 10
    // "world" = 5
    const result = wordWrap('hello 😀 world', 10);
    expect(result).toBe('hello 😀\nworld');
  });

  it('wraps correctly with mixed CJK and emoji', () => {
    // "你好" (4) + " " (1) + "😀" (2) = 7, fits in 8
    // "world" (5) fits in 8
    const result = wordWrap('你好 😀 world', 8);
    expect(result).toBe('你好 😀\nworld');
  });

  it('handles text with zero-width characters without affecting wrapping', () => {
    // ZWSP between "hello" and "world" — displayWidth sees it as "helloworld" (10)
    const result = wordWrap('hello​world foo bar', 10);
    // "hello​world" (10) fits, "foo bar" (7) fits
    expect(result).toBe('hello​world\nfoo bar');
  });

  it('handles combining characters without affecting width', () => {
    // "cafe" + combining acute (0-width) = display width 4
    const result = wordWrap('café latte mocha', 8);
    // "café" (4) + " " + "latte" (5) = 10 > 8, so "café" stays, "latte mocha" on next
    expect(result).toBe('café\nlatte\nmocha');
  });
});

describe('wordWrap with tabs (#700)', () => {
  it('leaves a tab part of its word, measured as no cells, without a start column', () => {
    // The callers that print the text as it is do not expand tabs, and count them as they always did.
    expect(wordWrap('a\tb c', 3)).toBe('a\tb\nc');
  });

  it('keeps a tab that fits and measures it to the next 8-column stop', () => {
    expect(wordWrap('ab\tcd', 20, 0)).toBe('ab\tcd');
    // `a` ends in column 1 and the tab takes 7 cells: `b` would end in column 9.
    expect(wordWrap('a\tb', 9, 0)).toBe('a\tb');
    expect(wordWrap('a\tb', 8, 0)).toBe('a\nb');
  });

  it('counts the stops from the column the rows start at', () => {
    // From column 5, `a` ends in column 6 and the tab takes 2 cells: `b` ends in column 4.
    expect(wordWrap('a\tb', 4, 5)).toBe('a\tb');
    expect(wordWrap('a\tb', 4, 0)).toBe('a\nb');
    expect(wordWrap('a\tb', 3, 5)).toBe('a\nb');
  });

  it('gives a continuation row stops of its own', () => {
    // The second row starts at column 0 again: `bb` ends in 2, so `c` fits after a tab to 8.
    expect(wordWrap('aaaaaaaaaa bb\tc', 12, 0)).toBe('aaaaaaaaaa\nbb\tc');
    // Drawn from column 3, `xx` ends in column 5 and the tab takes 3 cells instead of 6.
    expect(wordWrap('xx\tyy', 7, 3)).toBe('xx\tyy');
    expect(wordWrap('xx\tyy', 7, 0)).toBe('xx\nyy');
  });

  it('drops a tab that opens a row, closes it, or carries it past the width', () => {
    expect(wordWrap('\tx', 20, 0)).toBe('x');
    expect(wordWrap('abc\tdef', 8, 0)).toBe('abc\ndef');
    expect(wordWrap('ab\t', 10, 0)).toBe('ab\t');
    expect(wordWrap('ab\t', 5, 0)).toBe('ab');
    expect(wordWrap('\t\t', 5, 0)).toBe('');
  });

  it('wraps each line of the text from the start column', () => {
    expect(wordWrap('a\tb\nc\td', 9, 0)).toBe('a\tb\nc\td');
  });

  it('hard-wraps a word wider than the row and carries on after it', () => {
    expect(wordWrap('abcdefghij\tk', 4, 0)).toBe('abcd\nefgh\nij\nk');
    expect(wordWrap('abcdef\tk', 8, 0)).toBe('abcdef\nk');
    expect(wordWrap('abcdefg\tk', 6, 0)).toBe('abcdef\ng\nk');
  });

  it('never makes a row wider than the width once its tabs are expanded', () => {
    const text = 'name\tvalue\t\tunit  and\ta rather long comment\tabout it all\t\tENDX';
    for (const start of [0, 1, 2, 5, 7]) {
      for (let width = 6; width < 60; width++) {
        const rows = wordWrap(text, width, start).split('\n');
        for (const row of rows) {
          const expanded = expandTabs(row, displayWidth, start);
          expect(
            displayWidth(expanded),
            `start ${start} width ${width} ${JSON.stringify(row)}`,
          ).toBeLessThanOrEqual(width);
        }
        expect(rows.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
      }
    }
  });
});

describe('hardWrap', () => {
  it('returns text unchanged when it fits', () => {
    expect(hardWrap('hello', 10)).toBe('hello');
  });

  it('breaks mid-word by display width', () => {
    expect(hardWrap('abcdefghij', 4)).toBe('abcd\nefgh\nij');
  });

  it('preserves existing newlines while wrapping each line', () => {
    expect(hardWrap('abcdef\nghijkl', 3)).toBe('abc\ndef\nghi\njkl');
  });

  it('handles CJK without splitting code points incorrectly', () => {
    // each CJK char is 2 wide → width 4 fits two chars; width 3 fits one
    expect(hardWrap('你好世界', 4)).toBe('你好\n世界');
    expect(hardWrapLine('你好世界', 3)).toEqual(['你', '好', '世', '界']);
    expect(hardWrapLine('你好世界', 4)).toEqual(['你好', '世界']);
  });

  it('handles emoji as 2-wide units', () => {
    expect(hardWrap('😀😀😀', 4)).toBe('😀😀\n😀');
  });
});

describe('padDisplay', () => {
  it('pads ASCII to width', () => {
    expect(padDisplay('hi', 5)).toBe('hi   ');
    expect(padDisplay('hi', 5, 'right')).toBe('   hi');
    expect(padDisplay('hi', 5, 'center')).toBe(' hi  ');
  });

  it('pads CJK by display width', () => {
    expect(displayWidth(padDisplay('你好', 6))).toBe(6);
    expect(padDisplay('你好', 6)).toBe('你好  ');
  });

  it('truncates when text exceeds width', () => {
    expect(displayWidth(padDisplay('hello world', 5))).toBe(5);
  });
});

describe('status glyph widths agree with the renderer', () => {
  // The transcript grid assumes a two-column gutter: one glyph plus one space.
  // If our width model disagrees with Ink's, every row carrying that glyph sits
  // on a different content column from the rest, and the padding we compute is
  // wrong by that much. Verified against Ink's own layout.
  it('measures every status glyph as one column', () => {
    // The hedera spinner's fleurons and the rubric marks included: ☙ sits in
    // Misc Symbols, which used to be measured as wide throughout.
    for (const glyph of [
      '✓',
      '✗',
      '×',
      '–',
      '?',
      '◌',
      '•',
      '└',
      '▸',
      '◆',
      '│',
      '─',
      '⠋',
      '❦',
      '❧',
      '☙',
      '¶',
      '§',
      '☆',
      '♠',
      '●',
      '⏺',
      '⎿',
      '⌘',
      // A dialog's edge (`DIALOG_EDGE`), repeated across the screen.
      '▔',
    ]) {
      expect(displayWidth(glyph), `${glyph} (U+${glyph.codePointAt(0)!.toString(16)})`).toBe(1);
    }
  });

  it('still measures emoji-presentation characters as two columns', () => {
    for (const glyph of ['✅', '❌', '✨', '🙂', '🚀', '☔', '⚡', '⛔', '⌚', '⏳', '⏰']) {
      expect(displayWidth(glyph), glyph).toBe(2);
    }
  });

  it('measures the East Asian Wide angle brackets in Misc Technical as two columns', () => {
    // U+2329 and U+232A sit in the text-default block but are East Asian Wide, as string-width
    // and the terminal measure them.
    expect(displayWidth('〈')).toBe(2);
    expect(displayWidth('〉')).toBe(2);
  });
});
