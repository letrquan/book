/**
 * The "assemble" startup splash: a pixel-art open book gathered out of a dim dot field. Dots lift
 * off the field and stream inward on curving paths, landing as the book's pixels from the spine
 * outward while corner brackets close in. When the last pixel lands the brackets lock in the
 * theme's brand colour, the code lines on the pages light up as if read, the BOOK wordmark is
 * stamped beneath, and the whole picture dissolves into the title page.
 *
 * Pixels are drawn two to a cell with half blocks, so they come out roughly square. Everything is a
 * pure function of (width, height, tick, theme), which keeps every frame testable.
 */
import type { ThemeTokens } from '../types/theme.js';
import { hashNoise } from './startup-fire.js';

export interface StartupAssembleRun {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export type StartupAssemblePhase = 'boot' | 'gather' | 'read' | 'dissolve';

export interface StartupAssembleFrame {
  rows: StartupAssembleRun[][];
  phase: StartupAssemblePhase;
}

/** Ticks of the `cinematic` UI clock (50 ms): about three seconds. */
export const STARTUP_ASSEMBLE_TOTAL_TICKS = 64;
const FADE_IN_END = 4;
const GATHER_START = 2;
/** Every pixel has landed by this tick; the brackets lock on it. */
export const STARTUP_ASSEMBLE_LOCK_TICK = 33;
const LOCK = STARTUP_ASSEMBLE_LOCK_TICK;
const DISSOLVE_START = 54;

const TAGLINE = 'Your coding workspace, indexed.';
const SCRAMBLE = '#%&*+=-:/\\<>[]{}01';

/** Pixel tones: 0 is empty, 1–3 climb a cool grey ramp, 4 is the theme's brand colour. */
type Tone = 0 | 1 | 2 | 3 | 4;
const RAMP = ['', '#34363c', '#8a8d94', '#f2f2f2'] as const;
const DOT_DIM = '#3a3c42';
const DOT_LIT = '#8a8d94';

const GLYPHS: Record<string, readonly string[]> = {
  B: ['####.', '#...#', '####.', '#...#', '####.'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  K: ['#..#.', '#.#..', '##...', '#.#..', '#..#.'],
};
const WORD = 'BOOK';

interface CellStyle {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export interface AssembleLayout {
  width: number;
  pixelHeight: number;
  /** The book's bounding box, in pixels. */
  left: number;
  top: number;
  markWidth: number;
  markHeight: number;
  centerX: number;
  centerY: number;
  /** Top pixel row of the wordmark, and the cell row of the tagline. */
  wordTop: number;
  taglineRow: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function unit(...values: number[]): number {
  return hashNoise(...values) / 0x1_0000_0000;
}

export function phaseForAssemble(tick: number): StartupAssemblePhase {
  if (tick < GATHER_START) return 'boot';
  if (tick < LOCK) return 'gather';
  if (tick < DISSOLVE_START) return 'read';
  return 'dissolve';
}

export function layoutStartupAssemble(width: number, terminalHeight: number): AssembleLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows = Math.max(1, Math.floor(terminalHeight));
  const pixelHeight = rows * 2;
  let markHeight = Math.min(36, Math.max(6, Math.floor(pixelHeight * 0.4)));
  let markWidth = Math.round(markHeight * 1.9);
  const widthBudget = Math.max(10, safeWidth - 14);
  if (markWidth > widthBudget) {
    markWidth = widthBudget;
    markHeight = Math.max(6, Math.round(markWidth / 1.9));
  }
  const centerX = Math.floor(safeWidth / 2);
  const top = Math.max(2, Math.round(pixelHeight * 0.36 - markHeight / 2));
  const left = centerX - Math.floor(markWidth / 2);
  const centerY = top + markHeight / 2;
  // Below the book's bottom bracket, on an even row so the 5-pixel letters start a cell.
  const bracketBottom = Math.ceil(centerY + (markHeight / 2) * 1.22 + 3);
  const wordTop = bracketBottom + 2 + ((bracketBottom + 2) % 2);
  const taglineRow = Math.floor((wordTop + 5) / 2) + 1;
  return {
    width: safeWidth,
    pixelHeight,
    left,
    top,
    markWidth,
    markHeight,
    centerX,
    centerY,
    wordTop,
    taglineRow,
  };
}

/** What the open book holds at pixel (x, y): 0 nothing, 1 cover, 2 ink, 3 paper. */
export function bookPixel(layout: AssembleLayout, x: number, y: number): 0 | 1 | 2 | 3 {
  const halfW = layout.markWidth / 2;
  const halfH = layout.markHeight / 2;
  const u = (x + 0.5 - (layout.left + halfW)) / halfW;
  const v = (y + 0.5 - layout.centerY) / halfH;
  const au = Math.abs(u);
  if (au > 1) return 0;
  const pixelU = 1 / halfW;
  const pixelV = 1 / halfH;
  // Gull-wing pages: highest and lowest at the spine. The cover shows past them at the sides
  // and underneath.
  const pageEdge = 1 - 2.5 * pixelU;
  const top = -0.8 + 0.3 * Math.min(1, au) ** 1.4;
  const bottom = 0.6 + 0.2 * (1 - au) ** 2;
  const coverTop = top + 0.3;
  const coverBottom = bottom + 2.2 * pixelV;
  if (au > pageEdge) return v >= coverTop && v <= coverBottom ? 1 : 0;
  if (v < top) return 0;
  if (v > bottom) return v <= coverBottom ? 1 : 0;
  // The crease between the two pages.
  if (au < pixelU) return 0;

  // Ragged, indented lines, like code on the page.
  const pageTop = Math.ceil(layout.centerY + top * halfH - 0.5);
  const pageBottom = Math.floor(layout.centerY + bottom * halfH - 0.5);
  const row = y - pageTop;
  if (row < 2 || row % 3 !== 2 || y > pageBottom - 2) return 3;
  const line = Math.floor(row / 3);
  const side = u < 0 ? 0 : 1;
  // Reading position across the page: outer edge to spine on the left, spine to edge on the right.
  const t = side === 0 ? 1 - au : au;
  const indent = (hashNoise(line, side, 11) % 4) * 0.07;
  const start = (side === 0 ? 0.1 : 0.14) + indent;
  const end = (side === 0 ? 0.86 : 0.9) - (hashNoise(line, side, 29) % 5) * 0.11;
  return t >= start && t <= Math.max(start + 0.1, end) ? 2 : 3;
}

/**
 * The tick a book pixel lands on. The spine fills first and the outer edges last, with a little
 * jitter so the pages fill in grain rather than in rings.
 */
export function arrivalTick(layout: AssembleLayout, x: number, y: number): number {
  const u = (x + 0.5 - layout.centerX) / (layout.markWidth / 2);
  const v = (y + 0.5 - layout.centerY) / (layout.markHeight / 2);
  const radial = Math.min(1.2, Math.hypot(u, v * 0.8));
  return GATHER_START + 12 + Math.floor(radial * 11 + unit(x, y, 31) * 4);
}

function flightTicks(x: number, y: number): number {
  return 9 + (hashNoise(x, y, 37) % 5);
}

/**
 * Where a book pixel is while it flies in, or undefined before it lifts off. It starts on a dot
 * of the field and curves in, all pixels turning the same way so the gathering reads as a swirl.
 */
function flightPosition(
  layout: AssembleLayout,
  x: number,
  y: number,
  tick: number,
): [number, number] | undefined {
  const landAt = arrivalTick(layout, x, y);
  const flight = flightTicks(x, y);
  const launch = landAt - flight;
  if (tick < launch || tick >= landAt) return undefined;
  const rows = layout.pixelHeight / 2;
  // A dot of the field, in cells, then in pixels.
  const cellY = (hashNoise(x, y, 43) % Math.max(1, Math.floor(rows / 2))) * 2;
  const offset = ((cellY / 2) % 2) * 3;
  const sites = Math.max(1, Math.floor((layout.width - offset) / 6));
  const cellX = (hashNoise(x, y, 47) % sites) * 6 + offset;
  const sx = cellX;
  const sy = cellY * 2;
  const t = (tick - launch) / flight;
  const e = easeOut(t);
  const dx = x - sx;
  const dy = y - sy;
  const bend = Math.sin(Math.PI * t) * 0.35 * (1 - e * 0.5);
  return [Math.round(sx + dx * e - dy * bend), Math.round(sy + dy * e + dx * bend * 0.5)];
}

/** How far the gathering has come: 0 before the first dot lifts, 1 when the last lands. */
function gatherProgress(tick: number): number {
  return clamp01((tick - GATHER_START) / (LOCK - GATHER_START));
}

function toneColor(tone: Tone, accent: string): string | undefined {
  if (tone === 0) return undefined;
  return tone === 4 ? accent : RAMP[tone];
}

function sameStyle(left: CellStyle, right: CellStyle): boolean {
  return (
    left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.dimColor === right.dimColor
  );
}

function toRuns(cells: CellStyle[]): StartupAssembleRun[] {
  const runs: StartupAssembleRun[] = [];
  for (const cell of cells) {
    const previous = runs.at(-1);
    if (previous && sameStyle(previous, cell)) previous.text += cell.text;
    else runs.push({ ...cell });
  }
  return runs;
}

function paintPixels(layout: AssembleLayout, tick: number): Uint8Array {
  const { width, pixelHeight } = layout;
  const pixels = new Uint8Array(width * pixelHeight);
  const set = (x: number, y: number, tone: Tone) => {
    if (x < 0 || y < 0 || x >= width || y >= pixelHeight) return;
    pixels[y * width + x] = tone;
  };
  const phase = phaseForAssemble(tick);
  const dissolve = clamp01(
    (tick - DISSOLVE_START) / (STARTUP_ASSEMBLE_TOTAL_TICKS - DISSOLVE_START - 2),
  );
  // The code lines light up left to right once the brackets lock.
  const readX =
    layout.left +
    layout.markWidth * clamp01((tick - LOCK + 1) / 9) * 1.05 -
    layout.markWidth * 0.02;

  const flying: number[] = [];
  for (let y = layout.top - 1; y <= layout.top + layout.markHeight + 3; y++) {
    for (let x = layout.left; x < layout.left + layout.markWidth; x++) {
      const kind = bookPixel(layout, x, y);
      if (kind === 0) continue;
      const landAt = arrivalTick(layout, x, y);
      if (tick >= landAt) {
        // A pixel flashes white the tick it lands, then takes its own tone.
        const ink: Tone = phase !== 'gather' && x <= readX ? 4 : 2;
        const tone: Tone = tick === landAt ? 3 : kind === 3 ? 3 : kind === 2 ? ink : 2;
        set(x, y, tone);
        continue;
      }
      const position = flightPosition(layout, x, y, tick);
      if (position) flying.push(position[0], position[1]);
    }
  }
  // In flight a pixel is mid grey, and never covers one that has landed.
  for (let index = 0; index < flying.length; index += 2) {
    const fx = flying[index];
    const fy = flying[index + 1];
    if (fx < 0 || fy < 0 || fx >= width || fy >= pixelHeight) continue;
    if (!pixels[fy * width + fx]) pixels[fy * width + fx] = 2;
  }

  const halfW = layout.markWidth / 2;
  const halfH = layout.markHeight / 2;
  // Corner brackets close in as the book gathers and lock in the brand colour.
  if (tick >= GATHER_START) {
    const spread = 1.5 - 0.4 * easeInOut(gatherProgress(tick));
    const bx = Math.round(halfW * spread + 2);
    const by = Math.round(halfH * spread + 3);
    const arm = Math.max(3, Math.round(halfW * 0.2));
    const tone: Tone = tick >= LOCK ? 4 : 3;
    const cy = Math.round(layout.centerY);
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const cornerX = layout.centerX + sx * bx;
      const cornerY = cy + sy * by;
      for (let i = 0; i < arm; i++) set(cornerX - sx * i, cornerY, tone);
      for (let i = 0; i < Math.max(2, Math.round(arm * 0.6)); i++)
        set(cornerX, cornerY - sy * i, tone);
    }
  }

  // The wordmark is stamped one letter at a time: a frame of noise, then the glyph.
  // Only where the letters clear the hint row.
  if (tick >= LOCK && Math.ceil((layout.wordTop + 5) / 2) < layout.pixelHeight / 2 - 1) {
    const letterWidth = 5;
    const gap = 2;
    const total = WORD.length * letterWidth + (WORD.length - 1) * gap;
    const wordLeft = layout.centerX - Math.floor(total / 2);
    for (let index = 0; index < WORD.length; index++) {
      const shownAt = LOCK + index * 2;
      if (tick < shownAt) continue;
      const glyph = GLYPHS[WORD[index]];
      const noisy = tick === shownAt;
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < letterWidth; column++) {
          const x = wordLeft + index * (letterWidth + gap) + column;
          const y = layout.wordTop + row;
          if (noisy) {
            if (unit(x, y, tick) < 0.5) set(x, y, 2);
          } else if (glyph[row][column] === '#') {
            set(x, y, 3);
          }
        }
      }
    }
  }

  if (dissolve > 0) {
    for (let index = 0; index < pixels.length; index++) {
      if (pixels[index] && unit(index, 7) < dissolve) pixels[index] = 0;
    }
  }
  return pixels;
}

function dotAt(x: number, y: number): boolean {
  if (y % 2 !== 0) return false;
  return (x + ((y / 2) % 2) * 3) % 6 === 0;
}

function writeText(
  cells: CellStyle[][],
  row: number,
  column: number,
  text: string,
  style: (index: number) => Omit<CellStyle, 'text'> & { char?: string },
): void {
  if (row < 0 || row >= cells.length) return;
  for (let index = 0; index < text.length; index++) {
    const x = column + index;
    if (x < 0 || x >= cells[row].length) continue;
    const { char, ...rest } = style(index);
    cells[row][x] = { text: char ?? text[index], ...rest };
  }
}

/** Shifts one row of cells sideways, filling the gap with blanks. */
function shiftRow(row: CellStyle[], offset: number): CellStyle[] {
  if (offset === 0) return row;
  return row.map((_, x) => row[x - offset] ?? { text: ' ' });
}

export function composeStartupAssembleFrame(
  width: number,
  terminalHeight: number,
  tick: number,
  theme: ThemeTokens,
): StartupAssembleFrame {
  const layout = layoutStartupAssemble(width, terminalHeight);
  const height = Math.max(1, Math.floor(terminalHeight));
  const accent = theme.brand;
  const phase = phaseForAssemble(tick);
  const pixels = paintPixels(layout, tick);
  const fade = clamp01(tick / FADE_IN_END);
  const dissolve = clamp01(
    (tick - DISSOLVE_START) / (STARTUP_ASSEMBLE_TOTAL_TICKS - DISSOLVE_START - 2),
  );
  const cy = layout.centerY / 2;

  let cells: CellStyle[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: layout.width }, (_, x): CellStyle => {
      const top = toneColor(pixels[y * 2 * layout.width + x] as Tone, accent);
      const bottom = toneColor(pixels[(y * 2 + 1) * layout.width + x] as Tone, accent);
      if (top && bottom)
        return top === bottom
          ? { text: '█', color: top }
          : { text: '▀', color: top, backgroundColor: bottom };
      if (top) return { text: '▀', color: top };
      if (bottom) return { text: '▄', color: bottom };
      if (!dotAt(x, y)) return { text: ' ' };
      // The dot field fades in, ripples out from the book, and dissolves with it.
      // Dots lift off the field to become the book, thinning it as the gathering runs.
      if (unit(x, y, 3) > fade || unit(x, y, 5) < dissolve) return { text: ' ' };
      if (unit(x, y, 9) < gatherProgress(tick) * 0.55) return { text: ' ' };
      const distance = Math.hypot(x - layout.centerX, (y - cy) * 2);
      const lit = phase !== 'dissolve' && Math.sin(distance / 3 - tick * 0.45) > 0.86;
      return { text: '·', color: lit ? DOT_LIT : DOT_DIM };
    }),
  );

  // The tagline decodes out of scrambled characters, left to right.
  const taglineStart = LOCK + WORD.length * 2;
  if (tick >= taglineStart && layout.taglineRow < height - 1 && TAGLINE.length <= layout.width) {
    const column = Math.max(0, Math.floor((layout.width - TAGLINE.length) / 2));
    writeText(cells, layout.taglineRow, column, TAGLINE, (index) => {
      const settled = tick - taglineStart >= index * 0.25;
      if (dissolve > 0 && unit(index, 13) < dissolve) return { char: ' ' };
      if (settled || TAGLINE[index] === ' ') return { color: theme.text };
      return {
        char: SCRAMBLE[hashNoise(index, tick) % SCRAMBLE.length],
        color: theme.subtle,
        dimColor: true,
      };
    });
  }

  // Glitch: the lock lands with a jolt.
  const torn = new Set<number>();
  if (tick === LOCK || tick === LOCK + 1) {
    const count = 3 + (hashNoise(tick, 5) % 3);
    for (let index = 0; index < count; index++) {
      torn.add(hashNoise(tick, index, 17) % height);
    }
  }
  if (torn.size > 0) {
    cells = cells.map((row, y) => {
      if (!torn.has(y)) return row;
      const offset = (hashNoise(tick, y, 23) % 9) - 4;
      return shiftRow(row, offset);
    });
  }

  if (phase !== 'dissolve' && layout.width >= 18 && height >= 2) {
    const hint = 'Esc skip';
    writeText(cells, height - 1, layout.width - hint.length - 1, hint, () => ({
      color: theme.subtle,
      dimColor: true,
    }));
  }

  return { phase, rows: cells.map(toRuns) };
}
