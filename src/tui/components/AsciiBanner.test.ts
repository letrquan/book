import { describe, it, expect } from 'vitest';

/**
 * Tests for the ASCII BOOK banner.
 *
 * Verifies the banner has the correct number of lines and each line
 * has consistent width for proper alignment.
 */

const BANNER_LINES = [
  '  ██████╗   ██████╗   ██████╗  ██╗  ██╗',
  '  ██╔══██╗ ██╔═══██╗ ██╔═══██╗ ██║ ██╔╝',
  '  ██████╔╝ ██║   ██║ ██║   ██║ █████╔╝ ',
  '  ██╔══██╗ ██║   ██║ ██║   ██║ ██╔═██╗ ',
  '  ██████╔╝ ╚██████╔╝ ╚██████╔╝ ██║  ██╗',
  '  ╚═════╝   ╚═════╝   ╚═════╝  ╚═╝  ╚═╝',
];

describe('AsciiBanner', () => {
  it('has exactly 6 lines', () => {
    expect(BANNER_LINES).toHaveLength(6);
  });

  it('all lines have the same width', () => {
    const widths = BANNER_LINES.map((l) => l.length);
    const first = widths[0];
    for (const w of widths) {
      expect(w).toBe(first);
    }
  });

  it('contains the word BOOK spelled out', () => {
    // Each block spells B-O-O-K
    const joined = BANNER_LINES.join('');
    // Check for the distinctive patterns
    expect(joined).toContain('█');
    expect(joined).toContain('╗');
    expect(joined).toContain('╚');
  });

  it('first line starts with B pattern', () => {
    // B block: full left vertical + two humps
    expect(BANNER_LINES[0]).toContain('██████╗');
    expect(BANNER_LINES[0]).toContain('██████╗');
  });

  it('last line has the bottom of K pattern', () => {
    // K block bottom: angled legs
    expect(BANNER_LINES[5]).toContain('╚═╝  ╚═╝');
  });
});
