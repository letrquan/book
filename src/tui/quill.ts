/**
 * Book's spinner: the quill.
 *
 * A nib writes a flourish, a lemniscate (∞), across four braille cells one dot
 * at a time. It touches down at the left, climbs over the left lobe, dives
 * through the knot, rounds the right lobe and comes back through the knot to
 * close where it began, slowing through the tight turns the way a hand does.
 * The ink is wet at the nib, rubric red just behind it, and dries to grey as it
 * ages; once the pen lifts the mark dries faster, then the ink lifts off in the
 * order it was laid down, and the next stroke touches down beside the last
 * speck of the old one. Forty-eight frames at the 50ms clock: 2.4 seconds.
 *
 * The frames carry each cell's ink state (how old its freshest ink is, and how
 * much of the nib's wet glow reaches it) rather than colours, so the palette
 * comes from the theme at render time.
 *
 * It replaced a hedera fleuron that had three poses: Unicode holds that
 * ornament in three orientations and no angles between them.
 */

/** The ink in one cell of a frame. */
export interface QuillInk {
  /** Frames since the freshest ink in the cell was laid, dry time included; `null` when bare. */
  age: number | null;
  /** How much of the nib's wet glow reaches the cell, 0–1. */
  wet: number;
}

export interface QuillFrame {
  /** Four braille cells. */
  text: string;
  ink: readonly QuillInk[];
}

/** The colours ink is drawn in, from the theme. */
export interface QuillPalette {
  /** Fresh ink: the rubric. */
  fresh: string;
  /** Ink under the nib: the rubric's lighter shimmer. */
  wet: string;
  /** Ink part dry. */
  drying: string;
  /** Dry ink, and bare cells. */
  dry: string;
}

export const QUILL_CELLS = 4;
export const QUILL_FRAME_COUNT = 48;

/** Frames the nib spends writing, eased and slower through tight turns. */
const WRITE_FRAMES = 30;
/**
 * The ink lifts oldest first, two specks a frame (one to begin); the last speck
 * goes on the frame the next stroke touches down, so no frame is blank.
 */
const LIFT_START = QUILL_FRAME_COUNT - 8;
/** Extra dwell per radian of turn, like a hand in a curve. */
const TURN_COST = 0.75;
/** Blend of linear and smoothstep timing: a slow start and finish. */
const WRITE_EASE = 0.35;
/** Once the pen lifts, the whole mark dries this much faster. */
const DRY_BOOST = 1.2;
/** Dots past its own cell that the nib's wet glow reaches. */
const NIB_REACH = 2;
/** Frames the glow takes to go once the pen lifts. */
const NIB_FADE = 4;
/** Frames the ink takes to start flowing after touchdown. */
const NIB_RAMP = 6;

/**
 * The flourish on the 8×4 dot canvas, in pen order:
 *
 *   . X X . . X X .
 *   X . . X X . . X
 *   X . . X X . . X
 *   . X X . . X X .
 */
const STROKE: readonly (readonly [number, number])[] = [
  [0, 2],
  [0, 1],
  [1, 0],
  [2, 0],
  [3, 1],
  [4, 2],
  [5, 3],
  [6, 3],
  [7, 2],
  [7, 1],
  [6, 0],
  [5, 0],
  [4, 1],
  [3, 2],
  [2, 3],
  [1, 3],
];

/** Braille dot bit for a dot in column 0..1, row 0..3 of one cell. */
const DOT_BIT: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

interface TimedDot {
  x: number;
  y: number;
  /** Frame the nib lays it. */
  laid: number;
  /** Frame it lifts off. */
  lifted: number;
}

function timeStroke(): TimedDot[] {
  // A unit of travel per dot, plus dwell where the stroke turns.
  const costs = STROKE.map(([x, y], index) => {
    if (index === 0 || index === STROKE.length - 1) return 1;
    const [px, py] = STROKE[index - 1]!;
    const [nx, ny] = STROKE[index + 1]!;
    let turn = Math.abs(Math.atan2(ny - y, nx - x) - Math.atan2(y - py, x - px));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return 1 + TURN_COST * turn;
  });
  const reached: number[] = [];
  let travelled = 0;
  for (const cost of costs) {
    reached.push(travelled);
    travelled += cost;
  }
  const end = reached[reached.length - 1]!;
  const eased = (t: number) => (1 - WRITE_EASE) * t + WRITE_EASE * smoothstep(t);
  // Invert the easing: the time at which the eased journey reaches `progress`.
  const timeAt = (progress: number) => {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 40; step++) {
      const mid = (low + high) / 2;
      if (eased(mid) < progress) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  return STROKE.map(([x, y], index) => ({
    x,
    y,
    laid: reached[index] === 0 ? 0 : WRITE_FRAMES * timeAt(reached[index]! / end),
    lifted: LIFT_START + Math.ceil(index / 2),
  }));
}

function buildFrames(): QuillFrame[] {
  const dots = timeStroke();
  const penUp = dots[dots.length - 1]!.laid;
  const nibX = (tau: number) => {
    for (let index = 0; index < dots.length - 1; index++) {
      const here = dots[index]!;
      const next = dots[index + 1]!;
      if (tau < next.laid) {
        const k = clamp01((tau - here.laid) / (next.laid - here.laid));
        return here.x + (next.x - here.x) * k;
      }
    }
    return dots[dots.length - 1]!.x;
  };
  const nibStrength = (tau: number) => {
    if (tau < 0) return 0;
    if (tau <= penUp) return 0.35 + 0.65 * smoothstep(clamp01(tau / NIB_RAMP));
    return clamp01(1 - (tau - penUp) / NIB_FADE);
  };

  const frames: QuillFrame[] = [];
  for (let frame = 0; frame < QUILL_FRAME_COUNT; frame++) {
    const bits = new Array<number>(QUILL_CELLS).fill(0);
    const age = new Array<number>(QUILL_CELLS).fill(Infinity);
    const wet = new Array<number>(QUILL_CELLS).fill(0);
    // This cycle's stroke and its neighbours', so the loop has no seam.
    for (const tau of [frame, frame + QUILL_FRAME_COUNT, frame - QUILL_FRAME_COUNT]) {
      let inked = false;
      for (const dot of dots) {
        if (tau < dot.laid || tau >= dot.lifted) continue;
        inked = true;
        const cell = Math.floor(dot.x / 2);
        bits[cell]! |= DOT_BIT[dot.x % 2]![dot.y]!;
        const dried = tau - dot.laid + DRY_BOOST * Math.max(0, tau - penUp);
        age[cell] = Math.min(age[cell]!, dried);
      }
      if (!inked) continue;
      const strength = nibStrength(tau);
      const x = nibX(tau);
      for (let cell = 0; cell < QUILL_CELLS; cell++) {
        const distance = Math.max(0, 2 * cell - 0.5 - x, x - (2 * cell + 1.5));
        wet[cell] = Math.max(wet[cell]!, strength * smoothstep(clamp01(1 - distance / NIB_REACH)));
      }
    }
    frames.push({
      text: bits.map((bit) => String.fromCodePoint(0x2800 + bit)).join(''),
      ink: age.map((cellAge, cell) =>
        Number.isFinite(cellAge) ? { age: cellAge, wet: wet[cell]! } : { age: null, wet: 0 },
      ),
    });
  }
  return frames;
}

/** The spinner's frames, in order. */
export const QUILL_FRAMES: readonly QuillFrame[] = buildFrames();

/** The finished flourish in fresh ink: the still frame, for reduced motion. */
export const QUILL_STILL: QuillFrame = {
  text: (() => {
    const bits = new Array<number>(QUILL_CELLS).fill(0);
    for (const [x, y] of STROKE) bits[Math.floor(x / 2)]! |= DOT_BIT[x % 2]![y]!;
    return bits.map((bit) => String.fromCodePoint(0x2800 + bit)).join('');
  })(),
  ink: new Array<QuillInk>(QUILL_CELLS).fill({ age: 0, wet: 0 }),
};

/** Frames ink stays fresh, is part dry, and is dry. */
const FRESH_FOR = 9;
const HALF_DRY_AT = 22;
const DRY_AT = 34;

/**
 * The colour of each cell of `frame`. `mix(from, to, t)` blends two colours;
 * it is passed in so this module stays free of the theme's colour parsing.
 */
export function quillColors(
  frame: QuillFrame,
  palette: QuillPalette,
  mix: (from: string, to: string, t: number) => string,
): string[] {
  const inkAt = (age: number) => {
    if (age <= FRESH_FOR) return palette.fresh;
    if (age <= HALF_DRY_AT) {
      return mix(
        palette.fresh,
        palette.drying,
        smoothstep((age - FRESH_FOR) / (HALF_DRY_AT - FRESH_FOR)),
      );
    }
    if (age <= DRY_AT) {
      return mix(
        palette.drying,
        palette.dry,
        smoothstep((age - HALF_DRY_AT) / (DRY_AT - HALF_DRY_AT)),
      );
    }
    return palette.dry;
  };
  return frame.ink.map((cell) => {
    if (cell.age === null) return palette.dry;
    const base = inkAt(cell.age);
    return cell.wet > 0 ? mix(base, palette.wet, cell.wet) : base;
  });
}
