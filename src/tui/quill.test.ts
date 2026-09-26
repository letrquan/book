import { describe, expect, it } from 'vitest';
import { displayWidth } from './components/word-wrap.js';
import { mixColor } from './shimmer.js';
import {
  QUILL_CELLS,
  QUILL_FRAME_COUNT,
  QUILL_FRAMES,
  QUILL_STILL,
  quillColors,
  type QuillFrame,
} from './quill.js';

/** The dots a frame has inked, as `x,y` keys on the 8×4 canvas. */
function dots(frame: QuillFrame): Set<string> {
  const bits = [
    [0x01, 0x02, 0x04, 0x40],
    [0x08, 0x10, 0x20, 0x80],
  ];
  const set = new Set<string>();
  [...frame.text].forEach((cell, index) => {
    const value = cell.codePointAt(0)! - 0x2800;
    for (let column = 0; column < 2; column++) {
      for (let row = 0; row < 4; row++) {
        if (value & bits[column]![row]!) set.add(`${index * 2 + column},${row}`);
      }
    }
  });
  return set;
}

const PALETTE = { fresh: '#e4573d', wet: '#f28a6e', drying: '#a09a8f', dry: '#6f6a61' };

describe('the quill spinner', () => {
  it('writes, dries and lifts a flourish in forty-eight frames', () => {
    expect(QUILL_FRAMES).toHaveLength(QUILL_FRAME_COUNT);
    expect(QUILL_FRAME_COUNT).toBe(48);
  });

  it('keeps every frame four cells wide, one ink state per cell', () => {
    for (const frame of QUILL_FRAMES) {
      expect([...frame.text]).toHaveLength(QUILL_CELLS);
      expect(displayWidth(frame.text)).toBe(QUILL_CELLS);
      expect(frame.ink).toHaveLength(QUILL_CELLS);
    }
  });

  it('moves at most two dots a frame, across the loop seam too', () => {
    QUILL_FRAMES.forEach((frame, index) => {
      const next = QUILL_FRAMES[(index + 1) % QUILL_FRAMES.length]!;
      const before = dots(frame);
      const after = dots(next);
      const changed =
        [...before].filter((dot) => !after.has(dot)).length +
        [...after].filter((dot) => !before.has(dot)).length;
      expect(changed).toBeLessThanOrEqual(2);
    });
  });

  it('never shows a blank frame', () => {
    for (const frame of QUILL_FRAMES) expect(dots(frame).size).toBeGreaterThan(0);
  });

  it('finishes the whole flourish before the ink lifts', () => {
    const whole = dots(QUILL_STILL).size;
    expect(whole).toBe(16);
    expect(QUILL_FRAMES.some((frame) => dots(frame).size === whole)).toBe(true);
  });

  it('keeps the ink wet at the nib and lets the finished mark dry', () => {
    // While writing, some cell is under the nib's glow.
    expect(QUILL_FRAMES.slice(2, 28).every((frame) => frame.ink.some((cell) => cell.wet > 0))).toBe(
      true,
    );
    // By the time the ink lifts, the whole mark has dried past fresh.
    const lifting = QUILL_FRAMES[40]!;
    for (const cell of lifting.ink) {
      if (cell.age !== null) expect(cell.age).toBeGreaterThan(9);
    }
  });
});

describe('quillColors', () => {
  const frame = (ink: QuillFrame['ink']): QuillFrame => ({ text: '⠀⠀⠀⠀', ink });

  it('draws fresh ink in the rubric and dry ink in the quiet grey', () => {
    const colors = quillColors(
      frame([
        { age: 0, wet: 0 },
        { age: 60, wet: 0 },
        { age: null, wet: 0 },
        { age: 5, wet: 0 },
      ]),
      PALETTE,
      mixColor,
    );
    expect(colors).toEqual([PALETTE.fresh, PALETTE.dry, PALETTE.dry, PALETTE.fresh]);
  });

  it('dries ink through the half-dry grey, and wets it under the nib', () => {
    const [drying, wet] = quillColors(
      frame([
        { age: 22, wet: 0 },
        { age: 0, wet: 1 },
        { age: null, wet: 0 },
        { age: null, wet: 0 },
      ]),
      PALETTE,
      mixColor,
    );
    expect(drying).toBe(PALETTE.drying);
    expect(wet).toBe(PALETTE.wet);
  });

  it('stands still as the whole flourish in fresh ink', () => {
    expect(quillColors(QUILL_STILL, PALETTE, mixColor)).toEqual(
      new Array(QUILL_CELLS).fill(PALETTE.fresh),
    );
  });
});
