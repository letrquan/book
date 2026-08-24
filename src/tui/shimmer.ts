/**
 * Spinner shimmer.
 *
 * The spinner is the most-watched pixel in the TUI, so it gets the most care.
 * Two rules:
 *
 *  - It uses the theme's `shimmerPair`, never a literal colour. The gradient
 *    used to be hardcoded `['cyan', '#5cf']`, which put a bright blue strobe on
 *    a warm editorial palette in every theme.
 *  - It eases between the pair over a full revolution instead of swapping on
 *    every frame. Alternating two colours at the frame rate is a 5Hz strobe;
 *    easing across {@link SHIMMER_STEPS} frames reads as a breath.
 */

/** Frames in one shimmer cycle. Matches the spinner's revolution. */
export const SHIMMER_STEPS = 10;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(color: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Position within the breath for a frame index: 0 at the start, 1 at the
 * midpoint, back to 0 — a raised cosine, so the turn at each end is gradual
 * rather than a hard bounce.
 */
export function shimmerPhase(tick: number, steps = SHIMMER_STEPS): number {
  const period = Math.max(1, Math.floor(steps));
  const position = ((Math.floor(tick) % period) + period) % period;
  return (1 - Math.cos((2 * Math.PI * position) / period)) / 2;
}

/**
 * Blend a theme's shimmer pair at `tick`.
 *
 * Falls back to the first colour when either end is not a plain hex value —
 * custom themes may use Ink's named or `ansi256` colours, which cannot be
 * interpolated.
 */
export function shimmerColor(pair: readonly [string, string], tick: number): string {
  const [from, to] = pair;
  const start = parseHex(from);
  const end = parseHex(to);
  if (!start || !end) return from;
  const t = shimmerPhase(tick);
  return toHex({
    r: start.r + (end.r - start.r) * t,
    g: start.g + (end.g - start.g) * t,
    b: start.b + (end.b - start.b) * t,
  });
}
