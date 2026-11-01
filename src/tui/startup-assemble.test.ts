import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../types/theme.js';
import {
  arrivalTick,
  bookPixel,
  composeStartupAssembleFrame,
  layoutStartupAssemble,
  phaseForAssemble,
  STARTUP_ASSEMBLE_LOCK_TICK,
  STARTUP_ASSEMBLE_TOTAL_TICKS,
} from './startup-assemble.js';

type Rows = ReturnType<typeof composeStartupAssembleFrame>['rows'];

function frameText(rows: Rows): string {
  return rows.map((runs) => runs.map((run) => run.text).join('')).join('\n');
}

function colors(rows: Rows): Set<string | undefined> {
  return new Set(rows.flat().flatMap((run) => [run.color, run.backgroundColor]));
}

describe('composeStartupAssembleFrame', () => {
  it('is deterministic and keeps every row exactly as wide as the terminal', () => {
    for (const [width, height] of [
      [120, 39],
      [80, 23],
      [40, 11],
      [12, 4],
      [1, 1],
    ]) {
      for (let tick = 0; tick <= STARTUP_ASSEMBLE_TOTAL_TICKS; tick += 3) {
        const first = composeStartupAssembleFrame(width, height, tick, DEFAULT_THEME);
        expect(composeStartupAssembleFrame(width, height, tick, DEFAULT_THEME)).toEqual(first);
        expect(first.rows).toHaveLength(height);
        for (const runs of first.rows) {
          expect(Array.from(runs.map((run) => run.text).join(''))).toHaveLength(width);
        }
      }
    }
  });

  it('walks boot, scan, lock, read and dissolve in order', () => {
    const phases = Array.from({ length: STARTUP_ASSEMBLE_TOTAL_TICKS }, (_, tick) =>
      phaseForAssemble(tick),
    );
    const order = phases.filter((phase, index) => phase !== phases[index - 1]);
    expect(order).toEqual(['boot', 'gather', 'read', 'dissolve']);
  });

  it('gathers the book from the dot field and locks the brackets in the brand colour', () => {
    const layout = layoutStartupAssemble(110, 33);
    const arrivals: number[] = [];
    for (let y = layout.top - 1; y <= layout.top + layout.markHeight + 3; y++) {
      for (let x = layout.left; x < layout.left + layout.markWidth; x++) {
        if (bookPixel(layout, x, y)) arrivals.push(arrivalTick(layout, x, y));
      }
    }
    // Nothing lands before the field has faded in, and everything has landed by the lock.
    expect(Math.min(...arrivals)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...arrivals)).toBeLessThan(STARTUP_ASSEMBLE_LOCK_TICK);

    const gathering = composeStartupAssembleFrame(110, 33, 16, DEFAULT_THEME);
    expect(gathering.phase).toBe('gather');
    expect(colors(gathering.rows).has(DEFAULT_THEME.brand)).toBe(false);

    const locked = composeStartupAssembleFrame(110, 33, 40, DEFAULT_THEME);
    expect(colors(locked.rows).has(DEFAULT_THEME.brand)).toBe(true);
  });

  it('decodes the tagline in full before the picture dissolves', () => {
    const read = frameText(composeStartupAssembleFrame(80, 23, 52, DEFAULT_THEME).rows);
    expect(read).toContain('Your coding workspace, indexed.');
    expect(read).toContain('Esc skip');

    const last = composeStartupAssembleFrame(80, 23, STARTUP_ASSEMBLE_TOTAL_TICKS, DEFAULT_THEME);
    expect(last.phase).toBe('dissolve');
    expect(frameText(last.rows)).not.toContain('Esc skip');
  });
});

describe('layoutStartupAssemble', () => {
  it('keeps the book inside the terminal and leaves the hint row free', () => {
    for (const [width, height] of [
      [200, 60],
      [120, 39],
      [80, 23],
      [40, 11],
    ]) {
      const layout = layoutStartupAssemble(width, height);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.left + layout.markWidth).toBeLessThanOrEqual(width);
      expect(layout.top + layout.markHeight + 3).toBeLessThan(layout.pixelHeight - 2);
    }
  });

  it('draws two pages with a crease, paper, and lines of ink', () => {
    const layout = layoutStartupAssemble(120, 39);
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
