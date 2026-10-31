import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../types/theme.js';
import {
  bookPixel,
  composeStartupScanFrame,
  layoutStartupScan,
  phaseForScan,
  STARTUP_SCAN_TOTAL_TICKS,
} from './startup-scan.js';

type Rows = ReturnType<typeof composeStartupScanFrame>['rows'];

function frameText(rows: Rows): string {
  return rows.map((runs) => runs.map((run) => run.text).join('')).join('\n');
}

function colors(rows: Rows): Set<string | undefined> {
  return new Set(rows.flat().flatMap((run) => [run.color, run.backgroundColor]));
}

describe('composeStartupScanFrame', () => {
  it('is deterministic and keeps every row exactly as wide as the terminal', () => {
    for (const [width, height] of [
      [120, 39],
      [80, 23],
      [40, 11],
      [12, 4],
      [1, 1],
    ]) {
      for (let tick = 0; tick <= STARTUP_SCAN_TOTAL_TICKS; tick += 3) {
        const first = composeStartupScanFrame(width, height, tick, DEFAULT_THEME);
        expect(composeStartupScanFrame(width, height, tick, DEFAULT_THEME)).toEqual(first);
        expect(first.rows).toHaveLength(height);
        for (const runs of first.rows) {
          expect(Array.from(runs.map((run) => run.text).join(''))).toHaveLength(width);
        }
      }
    }
  });

  it('walks boot, scan, lock, read and dissolve in order', () => {
    const phases = Array.from({ length: STARTUP_SCAN_TOTAL_TICKS }, (_, tick) =>
      phaseForScan(tick),
    );
    const order = phases.filter((phase, index) => phase !== phases[index - 1]);
    expect(order).toEqual(['boot', 'scan', 'lock', 'read', 'dissolve']);
  });

  it('shows a readout while scanning and locks the brackets in the brand colour', () => {
    const scanning = composeStartupScanFrame(110, 33, 16, DEFAULT_THEME);
    expect(scanning.phase).toBe('scan');
    expect(frameText(scanning.rows)).toMatch(/\d{3}%/);
    expect(colors(scanning.rows).has(DEFAULT_THEME.brand)).toBe(false);

    const locked = composeStartupScanFrame(110, 33, 40, DEFAULT_THEME);
    expect(colors(locked.rows).has(DEFAULT_THEME.brand)).toBe(true);
  });

  it('decodes the tagline in full before the picture dissolves', () => {
    const read = frameText(composeStartupScanFrame(80, 23, 52, DEFAULT_THEME).rows);
    expect(read).toContain('Your coding workspace, indexed.');
    expect(read).toContain('Esc skip');

    const last = composeStartupScanFrame(80, 23, STARTUP_SCAN_TOTAL_TICKS, DEFAULT_THEME);
    expect(last.phase).toBe('dissolve');
    expect(frameText(last.rows)).not.toContain('Esc skip');
  });
});

describe('layoutStartupScan', () => {
  it('keeps the book inside the terminal and leaves the hint row free', () => {
    for (const [width, height] of [
      [200, 60],
      [120, 39],
      [80, 23],
      [40, 11],
    ]) {
      const layout = layoutStartupScan(width, height);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.left + layout.markWidth).toBeLessThanOrEqual(width);
      expect(layout.top + layout.markHeight + 3).toBeLessThan(layout.pixelHeight - 2);
    }
  });

  it('draws two pages with a crease, paper, and lines of ink', () => {
    const layout = layoutStartupScan(120, 39);
    const kinds = new Set<number>();
    for (let y = layout.top; y < layout.top + layout.markHeight + 3; y++) {
      for (let x = layout.left; x < layout.left + layout.markWidth; x++) {
        kinds.add(bookPixel(layout, x, y));
      }
    }
    expect([...kinds].sort()).toEqual([0, 1, 2, 3]);
    const crease = layout.left + Math.floor(layout.markWidth / 2);
    expect(bookPixel(layout, crease, Math.round(layout.centerY))).toBe(0);
  });
});
