import { describe, expect, it } from 'vitest';
import { expandTabs } from './tab-stops.js';
import { displayWidth } from './tui/components/word-wrap.js';

const RED = '\u001b[31m';
const NO_COLOUR = '\u001b[39m';

describe('expandTabs', () => {
  it('expands tabs to the next multiple-of-8 column', () => {
    expect(expandTabs('a\tb', displayWidth)).toBe(`a${' '.repeat(7)}b`);
    expect(expandTabs('abcdefg\tb', displayWidth)).toBe('abcdefg b');
    expect(expandTabs('abcdefgh\tb', displayWidth)).toBe(`abcdefgh${' '.repeat(8)}b`);
    expect(expandTabs('a\t\tb', displayWidth)).toBe(`a${' '.repeat(15)}b`);
    expect(expandTabs('你\tb', displayWidth)).toBe(`你${' '.repeat(6)}b`);
    expect(expandTabs('no tab', displayWidth)).toBe('no tab');
  });

  it('counts the columns from the one the text starts at, when it is drawn in from the edge', () => {
    // Four columns in, `ab` ends in column 6: the tab takes two cells, not six.
    expect(expandTabs('ab\tcd', displayWidth, 4)).toBe('ab  cd');
    expect(expandTabs('\tx', displayWidth, 4)).toBe(`${' '.repeat(4)}x`);
    expect(expandTabs('\tx', displayWidth, 8)).toBe(`${' '.repeat(8)}x`);
    expect(expandTabs('ab\tcd', displayWidth, 0)).toBe(expandTabs('ab\tcd', displayWidth));
  });

  it('expands a tab after styled text by its visible column', () => {
    expect(expandTabs(`${RED}red${NO_COLOUR}\tx`, displayWidth)).toBe(
      `${RED}red${NO_COLOUR}${' '.repeat(5)}x`,
    );
  });
});
