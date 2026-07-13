import { describe, expect, it } from 'vitest';
import { displayWidth } from './word-wrap.js';
import {
  allocateTableColumns,
  layoutCodeBlock,
  layoutHeadingChrome,
  layoutHorizontalRule,
  layoutTable,
  nestedContentWidth,
  sliceStyledLine,
} from './markdown-layout.js';

function maxLineWidth(text: string): number {
  return Math.max(0, ...text.split('\n').map((line) => displayWidth(line)));
}

describe('allocateTableColumns', () => {
  it('keeps natural widths when they fit', () => {
    expect(allocateTableColumns([4, 5], 40)).toEqual([4, 5]);
  });

  it('shrinks columns to fit terminal width', () => {
    const widths = allocateTableColumns([20, 20], 30);
    expect(widths).not.toBeNull();
    // total = sum(w) + 3n + 1 = sum + 7 for n=2
    const total = widths!.reduce((a, b) => a + b, 0) + 3 * 2 + 1;
    expect(total).toBeLessThanOrEqual(30);
    expect(widths!.every((w) => w >= 1)).toBe(true);
  });

  it('returns null when even minimum columns cannot fit', () => {
    expect(allocateTableColumns([3, 3, 3, 3], 8)).toBeNull();
  });
});

describe('layoutTable', () => {
  const sample = {
    header: [{ text: 'Name' }, { text: 'Value' }],
    rows: [
      [{ text: 'foo' }, { text: '42' }],
      [{ text: 'bar' }, { text: '99' }],
    ],
    align: ['left', 'right'] as Array<'left' | 'right'>,
  };

  it('produces borders matching body width', () => {
    const layout = layoutTable({ ...sample, terminalWidth: 40 });
    expect(layout.mode).toBe('grid');
    if (layout.mode !== 'grid') return;
    expect(displayWidth(layout.top)).toBe(layout.totalWidth);
    expect(displayWidth(layout.middle)).toBe(layout.totalWidth);
    expect(displayWidth(layout.bottom)).toBe(layout.totalWidth);
    // Body row reconstructed width matches borders.
    for (const row of [layout.headerCells, ...layout.bodyRows]) {
      const body = `│ ${row.join(' │ ')} │`;
      expect(displayWidth(body)).toBe(layout.totalWidth);
    }
  });

  it('wraps long cells instead of overflowing', () => {
    const layout = layoutTable({
      header: [{ text: 'Key' }, { text: 'Description' }],
      rows: [[{ text: 'id' }, { text: 'a very long description that should wrap' }]],
      terminalWidth: 28,
    });
    expect(layout.mode).toBe('grid');
    if (layout.mode !== 'grid') return;
    expect(layout.totalWidth).toBeLessThanOrEqual(28);
    expect(layout.bodyRows.length).toBeGreaterThan(1);
    for (const row of layout.bodyRows) {
      for (let ci = 0; ci < row.length; ci++) {
        expect(displayWidth(row[ci]!)).toBe(layout.colWidths[ci]!);
      }
    }
  });

  it('uses display-width for CJK cell measurement and padding', () => {
    const layout = layoutTable({
      header: [{ text: '名' }, { text: '値' }],
      rows: [[{ text: '你好' }, { text: '世界' }]],
      terminalWidth: 40,
    });
    expect(layout.mode).toBe('grid');
    if (layout.mode !== 'grid') return;
    expect(layout.colWidths[0]).toBeGreaterThanOrEqual(displayWidth('你好'));
    for (const row of layout.bodyRows) {
      expect(displayWidth(row[0]!)).toBe(layout.colWidths[0]!);
    }
  });

  it('falls back to stacked Header: value on very narrow widths', () => {
    const layout = layoutTable({
      header: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
      rows: [[{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }]],
      terminalWidth: 12,
    });
    expect(layout.mode).toBe('stacked');
    if (layout.mode !== 'stacked') return;
    expect(layout.lines.some((l) => l.includes('A:'))).toBe(true);
    expect(maxLineWidth(layout.lines.join('\n'))).toBeLessThanOrEqual(12);
  });

  it('keeps width invariants across narrow terminal widths', () => {
    const table = {
      header: [{ text: 'Name' }, { text: 'Value' }, { text: 'Note' }],
      rows: [
        [{ text: 'alpha' }, { text: '12345' }, { text: '你好 world 😀' }],
        [{ text: 'beta-long-key' }, { text: '999' }, { text: 'short' }],
      ],
    };
    for (const width of [12, 16, 20, 24, 32, 40, 60, 80]) {
      const layout = layoutTable({ ...table, terminalWidth: width });
      if (layout.mode === 'grid') {
        expect(layout.totalWidth).toBeLessThanOrEqual(width);
        expect(displayWidth(layout.top)).toBe(layout.totalWidth);
        expect(displayWidth(layout.bottom)).toBe(layout.totalWidth);
        for (const row of [...layout.headerRows, ...layout.bodyRows]) {
          const body = `│ ${row.join(' │ ')} │`;
          expect(displayWidth(body)).toBe(layout.totalWidth);
        }
      } else {
        expect(maxLineWidth(layout.lines.join('\n'))).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('layoutCodeBlock', () => {
  const longLine = 'const supercalifragilistic = "abcdefghijklmnopqrstuvwxyz";';
  const manyLines = Array.from({ length: 8 }, (_, i) => `line_${i}_${'x'.repeat(40)}`);

  it('hard-wraps unbroken lines and uses continuation gutters', () => {
    const layout = layoutCodeBlock([longLine], 30, { preferLineNumbers: false, lang: 'ts' });
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(layout.contentWidth);
    }
    // No line numbers requested → empty gutters
    expect(layout.lines.every((l) => l.gutter === '')).toBe(true);
  });

  it('shows continuation gutter spaces when line numbers are on', () => {
    const layout = layoutCodeBlock([longLine, 'short'], 28, { preferLineNumbers: true });
    if (layout.showLineNumbers) {
      const first = layout.lines.find((l) => !l.isContinuation);
      const cont = layout.lines.find((l) => l.isContinuation);
      expect(first?.gutter.trim().startsWith('1')).toBe(true);
      if (cont) {
        expect(cont.gutter.includes('│')).toBe(true);
        expect(cont.gutter.trimStart().startsWith('1')).toBe(false);
      }
    }
    for (const line of layout.lines) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(layout.contentWidth);
    }
  });

  it('drops border and/or line numbers when too narrow', () => {
    const layout = layoutCodeBlock(manyLines, 10, { preferLineNumbers: true, lang: 'js' });
    expect(layout.contentWidth).toBeGreaterThanOrEqual(1);
    for (const line of layout.lines) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(layout.contentWidth);
      if (layout.showLineNumbers) {
        expect(displayWidth(line.gutter) + displayWidth(line.text)).toBeLessThanOrEqual(10);
      } else {
        expect(displayWidth(line.text)).toBeLessThanOrEqual(10);
      }
    }
  });

  it('preserves source offsets for styled segment slicing', () => {
    const source = 'abcdefghij';
    const layout = layoutCodeBlock([source], 20, { preferLineNumbers: false });
    // Force wrap with tiny width
    const tight = layoutCodeBlock([source], 12, { preferLineNumbers: false });
    // contentWidth accounts for border+padding when shown
    expect(tight.lines.map((l) => l.text).join('')).toBe(source);
    let rebuilt = '';
    for (const line of tight.lines) {
      expect(source.slice(line.sourceStart, line.sourceEnd)).toBe(line.text);
      rebuilt += line.text;
    }
    expect(rebuilt).toBe(source);
    expect(layout.langLabel).toBeNull();
  });

  it('width invariant across narrow widths for long highlighted-like lines', () => {
    for (const width of [8, 12, 16, 20, 24, 40, 80]) {
      const layout = layoutCodeBlock(manyLines, width, {
        preferLineNumbers: true,
        lang: 'typescript',
      });
      expect(layout.contentWidth).toBeGreaterThanOrEqual(1);
      for (const line of layout.lines) {
        expect(displayWidth(line.text)).toBeLessThanOrEqual(layout.contentWidth);
        const rowWidth = displayWidth(line.gutter) + displayWidth(line.text);
        const chrome = layout.showBorder ? 4 : 0; // border(2)+padding(2)
        expect(rowWidth + chrome).toBeLessThanOrEqual(width + 1); // allow 1 for rounding edge
      }
      if (layout.langLabel) {
        expect(displayWidth(layout.langLabel)).toBeLessThanOrEqual(layout.contentWidth);
      }
    }
  });
});

describe('layoutHeadingChrome / hr / nested budgets', () => {
  it('clamps heading chrome to terminal width', () => {
    const h1 = layoutHeadingChrome('A Very Long Heading Title', 1, 20);
    expect(displayWidth(h1.prefix + h1.text + h1.suffix)).toBeLessThanOrEqual(20);
    const h2 = layoutHeadingChrome('Another Long Heading', 2, 18);
    expect(displayWidth(h2.prefix + h2.text + h2.suffix)).toBeLessThanOrEqual(18);
    const h3 = layoutHeadingChrome('### stuff that is long', 3, 12);
    expect(displayWidth(h3.prefix + h3.text)).toBeLessThanOrEqual(12);
  });

  it('builds horizontal rules within bounds', () => {
    expect(layoutHorizontalRule(10).length).toBeGreaterThanOrEqual(5);
    expect(layoutHorizontalRule(100).length).toBeLessThanOrEqual(60);
    expect(layoutHorizontalRule(undefined).length).toBe(40);
  });

  it('reduces nested content budgets', () => {
    expect(nestedContentWidth(40, { depth: 0, listGutter: 5 })).toBe(35);
    expect(nestedContentWidth(40, { depth: 2, listGutter: 5 })).toBe(31);
    expect(nestedContentWidth(40, { blockquoteDepth: 2, listGutter: 0 })).toBe(36);
    expect(nestedContentWidth(undefined)).toBeUndefined();
  });
});

describe('sliceStyledLine', () => {
  it('slices styled segments by character offsets', () => {
    const segs = [
      { text: 'const', color: 'blue' },
      { text: ' ', color: undefined },
      { text: 'x', color: 'white' },
      { text: ' = 1', color: 'yellow' },
    ];
    expect(sliceStyledLine(segs, 0, 5)).toEqual([{ text: 'const', color: 'blue' }]);
    expect(sliceStyledLine(segs, 6, 7)).toEqual([{ text: 'x', color: 'white' }]);
    expect(sliceStyledLine(segs, 4, 8)).toEqual([
      { text: 't', color: 'blue' },
      { text: ' ', color: undefined },
      { text: 'x', color: 'white' },
      { text: ' ', color: 'yellow' },
    ]);
  });
});
