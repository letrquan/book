/**
 * Deterministic terminal fire inspired by the PSX DOOM heat-buffer effect documented at
 * https://fabiensanglard.net/doom_fire_psx/. This is an independent implementation adapted for
 * Book's bounded, testable TUI renderer.
 */

export interface FireStepOptions {
  sourceStrength: number;
  sourceWidth: number;
  wind: number;
  protectedMask?: Uint8Array;
}

export interface BookRuneLayout {
  mask: Uint8Array;
  terminalTop: number;
  terminalHeight: number;
}

const GLYPHS: Record<string, readonly string[]> = {
  B: ['####.', '#...#', '####.', '#...#', '####.'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  K: ['#..#.', '#.#..', '##...', '#.#..', '#..#.'],
};

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixSeed(seed: number): number {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

export function hashNoise(...values: number[]): number {
  let hash = 0x9e3779b9;
  for (const value of values) hash = mixSeed(hash ^ Math.imul(value | 0, 0x85ebca6b));
  return hash >>> 0;
}

export function createBookRuneMask(width: number, pixelHeight: number): BookRuneLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(2, Math.floor(pixelHeight));
  const terminalHeight = Math.floor(safeHeight / 2);
  const scaleX = safeWidth >= 72 ? 2 : 1;
  const letters = 'BOOK';
  const glyphWidth = 5 * scaleX;
  const gap = scaleX;
  const runeWidth = letters.length * glyphWidth + (letters.length - 1) * gap;
  const left = Math.max(0, Math.floor((safeWidth - runeWidth) / 2));
  const terminalTop = Math.max(1, Math.floor(terminalHeight * 0.42) - 2);
  const mask = new Uint8Array(safeWidth * safeHeight);

  for (let letterIndex = 0; letterIndex < letters.length; letterIndex++) {
    const glyph = GLYPHS[letters[letterIndex]];
    const glyphLeft = left + letterIndex * (glyphWidth + gap);
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] !== '#') continue;
        for (let scale = 0; scale < scaleX; scale++) {
          const x = glyphLeft + column * scaleX + scale;
          const terminalY = terminalTop + row;
          if (x < 0 || x >= safeWidth || terminalY < 0 || terminalY >= terminalHeight) continue;
          mask[terminalY * 2 * safeWidth + x] = 1;
          mask[(terminalY * 2 + 1) * safeWidth + x] = 1;
        }
      }
    }
  }

  return { mask, terminalTop, terminalHeight: 5 };
}

export class StartupFireSimulation {
  private current: Uint8Array;
  private next: Uint8Array;
  private randomState: number;

  width: number;
  pixelHeight: number;

  constructor(width: number, pixelHeight: number, seed = 0x00b00c) {
    this.width = Math.max(1, Math.floor(width));
    this.pixelHeight = Math.max(2, Math.floor(pixelHeight));
    this.current = new Uint8Array(this.width * this.pixelHeight);
    this.next = new Uint8Array(this.current.length);
    this.randomState = seed >>> 0;
  }

  private random(maxExclusive: number): number {
    this.randomState = mixSeed(this.randomState || 1);
    return this.randomState % Math.max(1, maxExclusive);
  }

  get heat(): Uint8Array {
    return this.current;
  }

  step({ sourceStrength, sourceWidth, wind, protectedMask }: FireStepOptions): void {
    const width = this.width;
    const height = this.pixelHeight;
    const bottom = (height - 1) * width;
    const halfSource = Math.max(0, Math.min(width / 2, (width * sourceWidth) / 2));
    const center = (width - 1) / 2;

    for (let x = 0; x < width; x++) {
      const insideSource = Math.abs(x - center) <= halfSource;
      this.current[bottom + x] = insideSource
        ? clampByte(sourceStrength - this.random(28))
        : Math.max(0, this.current[bottom + x] - 28);
    }

    this.next.fill(0);
    for (let y = 0; y < height - 1; y++) {
      const belowY = y + 1;
      const lowerY = Math.min(height - 1, y + 2);
      for (let x = 0; x < width; x++) {
        const gust = Math.round(wind) + this.random(3) - 1;
        const sampleX = Math.max(0, Math.min(width - 1, x - gust));
        const left = Math.max(0, sampleX - 1);
        const right = Math.min(width - 1, sampleX + 1);
        const below = belowY * width;
        const lower = lowerY * width;
        const average =
          (this.current[below + sampleX] * 3 +
            this.current[below + left] +
            this.current[below + right] +
            this.current[lower + sampleX] * 2) /
          7;
        this.next[y * width + x] = clampByte(average - 2 - this.random(11));
      }
    }
    this.next.set(this.current.subarray(bottom, bottom + width), bottom);

    if (protectedMask?.length === this.next.length) {
      for (let index = 0; index < protectedMask.length; index++) {
        if (!protectedMask[index]) continue;
        this.next[index] = 0;
      }
      for (let index = 0; index < protectedMask.length; index++) {
        if (!protectedMask[index]) continue;
        const x = index % width;
        if (x > 0 && !protectedMask[index - 1]) {
          this.next[index - 1] = Math.max(this.next[index - 1], 190);
        }
        if (x + 1 < width && !protectedMask[index + 1]) {
          this.next[index + 1] = Math.max(this.next[index + 1], 190);
        }
      }
    }

    [this.current, this.next] = [this.next, this.current];
  }

  resize(width: number, pixelHeight: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(2, Math.floor(pixelHeight));
    if (nextWidth === this.width && nextHeight === this.pixelHeight) return;

    const resized = new Uint8Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y++) {
      const sourceY = Math.min(
        this.pixelHeight - 1,
        Math.floor((y / nextHeight) * this.pixelHeight),
      );
      for (let x = 0; x < nextWidth; x++) {
        const sourceX = Math.min(this.width - 1, Math.floor((x / nextWidth) * this.width));
        resized[y * nextWidth + x] = this.current[sourceY * this.width + sourceX];
      }
    }
    this.width = nextWidth;
    this.pixelHeight = nextHeight;
    this.current = resized;
    this.next = new Uint8Array(resized.length);
  }
}

export const STARTUP_FIRE_TOTAL_TICKS = 56;

export function startupFireStepOptions(tick: number): Omit<FireStepOptions, 'protectedMask'> {
  if (tick < 7) {
    return {
      sourceStrength: 255,
      sourceWidth: 0.04 + tick * 0.035,
      wind: Math.sin(tick * 0.6) * 0.7,
    };
  }
  if (tick < 34) {
    return {
      sourceStrength: 255,
      sourceWidth: Math.min(1.1, 0.28 + (tick - 7) * 0.08),
      wind: Math.sin(tick * 0.35) * 1.2,
    };
  }
  if (tick < 47) {
    const remaining = 1 - (tick - 34) / 13;
    return {
      sourceStrength: 255 * remaining,
      sourceWidth: 1,
      wind: Math.sin(tick * 0.42) * 1.5,
    };
  }
  return { sourceStrength: 0, sourceWidth: 0, wind: 0 };
}
