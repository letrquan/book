import type { ThemeTokens } from '../types/theme.js';
import { createBookRuneMask, hashNoise, type StartupFireSimulation } from './startup-fire.js';

export interface StartupFireRun {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export interface StartupFireFrame {
  rows: StartupFireRun[][];
  phase: 'spark' | 'inferno' | 'reveal' | 'ashes' | 'awakened';
}

interface CellStyle {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
}

const HEAT_PALETTE = [
  '#070707',
  '#1d0707',
  '#3a0907',
  '#5b0d06',
  '#7f1405',
  '#a52205',
  '#c93405',
  '#e84a07',
  '#f5660b',
  '#ff8612',
  '#ffaa22',
  '#ffcb43',
  '#ffe477',
  '#fff1b3',
  '#ffffff',
] as const;

const CODE_FRAGMENTS = ['{}', '=>', 'git', '@file', 'async', '<T>', '/help'];
const ASH_GLYPHS = ['·', '.', "'", '`'];

function phaseFor(tick: number): StartupFireFrame['phase'] {
  if (tick < 7) return 'spark';
  if (tick < 24) return 'inferno';
  if (tick < 44) return 'reveal';
  if (tick < 52) return 'ashes';
  return 'awakened';
}

export function heatColor(intensity: number): string | undefined {
  if (intensity < 5) return undefined;
  const index = Math.min(
    HEAT_PALETTE.length - 1,
    Math.floor((intensity / 255) * HEAT_PALETTE.length),
  );
  return HEAT_PALETTE[index];
}

function sameStyle(left: CellStyle, right: CellStyle): boolean {
  return (
    left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.dimColor === right.dimColor
  );
}

function toRuns(cells: CellStyle[]): StartupFireRun[] {
  const runs: StartupFireRun[] = [];
  for (const cell of cells) {
    const previous = runs.at(-1);
    if (previous && sameStyle(previous, cell)) {
      previous.text += cell.text;
    } else {
      runs.push({ ...cell });
    }
  }
  return runs;
}

function writeText(
  cells: CellStyle[][],
  row: number,
  text: string,
  style: Omit<CellStyle, 'text'>,
  centered = true,
): void {
  if (row < 0 || row >= cells.length) return;
  const left = centered ? Math.max(0, Math.floor((cells[row].length - text.length) / 2)) : 0;
  for (let index = 0; index < text.length && left + index < cells[row].length; index++) {
    cells[row][left + index] = { text: text[index], ...style };
  }
}

function addAtmosphere(
  cells: CellStyle[][],
  tick: number,
  theme: ThemeTokens,
  phase: StartupFireFrame['phase'],
): void {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  if (phase === 'spark') {
    for (let index = 0; index < CODE_FRAGMENTS.length; index++) {
      const text = CODE_FRAGMENTS[index];
      const x = hashNoise(index, width) % Math.max(1, width - text.length);
      const y = Math.min(height - 1, 1 + (hashNoise(index, height) % Math.max(1, height - 5)));
      for (let offset = 0; offset < text.length && x + offset < width; offset++) {
        cells[y][x + offset] = { text: text[offset], color: theme.subtle, dimColor: true };
      }
    }
    const sparkRow = Math.max(0, height - 3 - Math.floor(tick / 2));
    writeText(cells, sparkRow, tick < 3 ? '·' : tick < 5 ? '✦' : '⟡', {
      color: tick < 4 ? '#ffffff' : theme.brandShimmer,
      bold: true,
    });
    if (tick >= 3) {
      writeText(cells, Math.max(0, height - 5), 'KNOWLEDGE HAS A SPARK', {
        color: theme.brand,
        dimColor: tick < 5,
      });
    }
  }

  if (phase === 'inferno' || phase === 'reveal') {
    const emberCount = Math.min(32, Math.max(6, Math.floor(width / 5)));
    for (let index = 0; index < emberCount; index++) {
      const x = hashNoise(tick, index, width) % width;
      const y = hashNoise(tick - index, height, index) % Math.max(1, height - 2);
      if (cells[y][x].text !== ' ') continue;
      const glyph = ['·', '•', '*', '✦'][hashNoise(index, tick) % 4];
      cells[y][x] = {
        text: glyph,
        color: hashNoise(tick, x, y) % 4 === 0 ? '#fff1b3' : '#f5660b',
        bold: glyph === '✦',
      };
    }
  }

  if (phase === 'ashes' || phase === 'awakened') {
    const count = phase === 'ashes' ? Math.min(48, Math.floor(width / 2)) : 6;
    for (let index = 0; index < count; index++) {
      const x = hashNoise(index, tick, width) % width;
      const y = hashNoise(index * 7, tick, height) % Math.max(1, height - 1);
      if (cells[y][x].text !== ' ') continue;
      cells[y][x] = {
        text: ASH_GLYPHS[hashNoise(tick, index) % ASH_GLYPHS.length],
        color: theme.subtle,
        dimColor: true,
      };
    }
  }
}

export function composeStartupFireFrame(
  simulation: StartupFireSimulation,
  tick: number,
  terminalHeight: number,
  theme: ThemeTokens,
): StartupFireFrame {
  const width = simulation.width;
  const height = Math.max(1, Math.floor(terminalHeight));
  const heat = simulation.heat;
  const phase = phaseFor(tick);
  const rune = createBookRuneMask(width, simulation.pixelHeight);
  const cells: CellStyle[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x): CellStyle => {
      const topIndex = y * 2 * width + x;
      const bottomIndex = Math.min(simulation.pixelHeight - 1, y * 2 + 1) * width + x;
      const top = heat[topIndex] ?? 0;
      const bottom = heat[bottomIndex] ?? 0;
      const topColor = heatColor(top);
      const bottomColor = heatColor(bottom);
      if (!topColor && !bottomColor) return { text: ' ' };
      return {
        text: '▀',
        color: topColor ?? '#070707',
        backgroundColor: bottomColor ?? '#070707',
      };
    }),
  );

  if (phase === 'reveal') {
    const revealThreshold = Math.min(width, Math.max(0, (tick - 24) * Math.ceil(width / 14)));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const topIndex = y * 2 * width + x;
        if (!rune.mask[topIndex]) continue;
        const distanceFromCenter = Math.abs(x - width / 2) * 2;
        if (distanceFromCenter > revealThreshold) continue;
        cells[y][x] = {
          text: '█',
          color: tick < 29 ? '#ffffff' : tick < 34 ? '#fff1b3' : theme.brandShimmer,
          bold: true,
        };
      }
    }
    if (tick >= 35) {
      writeText(
        cells,
        Math.min(height - 2, rune.terminalTop + rune.terminalHeight + 2),
        'WHAT SURVIVES BECOMES KNOWLEDGE',
        {
          color: theme.brand,
          bold: true,
        },
      );
    }
  }

  addAtmosphere(cells, tick, theme, phase);

  if (phase === 'ashes' || phase === 'awakened') {
    const center = Math.floor(height / 2);
    writeText(cells, center - 1, '╭ BOOK', { color: theme.assistantAccent, bold: true });
    writeText(cells, center, '╰ Your coding workspace, indexed.', { color: theme.text });
    if (phase === 'awakened') {
      writeText(cells, center + 2, 'AGENT AWAKENED  ✦', {
        color: theme.brandShimmer,
        bold: true,
      });
    }
  }

  if (phase !== 'awakened' && width >= 18) {
    const hint = 'Esc skip';
    const row = cells[height - 1];
    const start = Math.max(0, width - hint.length - 1);
    for (let index = 0; index < hint.length; index++) {
      row[start + index] = { text: hint[index], color: theme.subtle, dimColor: true };
    }
  }

  return { phase, rows: cells.map(toRuns) };
}
