import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, FOLIO_THEME, RUBRIC_THEME, type ThemeTokens } from './theme.js';

/**
 * Rubric reading contrast.
 *
 * A palette is only as good as what it does to a long read. These numbers are
 * the ones a reader's eye actually judges — the body's contrast against the
 * terminal behind it, and the step between the body and the things meant to
 * stand above it.
 */

/** Windows Terminal's default background, the darkest common case. */
const BACKGROUND = '#0C0C0C';

/** WCAG 2.1 relative luminance: the sRGB transfer function, per channel. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two `#RRGGBB` colours. */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

describe('Rubric reading contrast', () => {
  it('sets the body about one step below white, to cut glare', () => {
    // Near-white body text on a near-black terminal is 15:1 and it glares. The
    // body drops to roughly 12:1, which still clears AAA for large text with
    // room to spare while the headings and the reader's own prompt gain
    // somewhere to stand.
    expect(contrast(RUBRIC_THEME.text, BACKGROUND)).toBeGreaterThan(11);
    expect(contrast(RUBRIC_THEME.text, BACKGROUND)).toBeLessThan(13);
  });

  it('lifts headings and your own prompt above the body', () => {
    for (const token of [
      RUBRIC_THEME.mdHeadingH1,
      RUBRIC_THEME.mdHeadingH2,
      RUBRIC_THEME.mdHeading,
      RUBRIC_THEME.userText,
    ] as const) {
      expect(contrast(token, RUBRIC_THEME.text)).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('keeps the secondary ramp in reading order above the background', () => {
    expect(contrast(RUBRIC_THEME.inactive, BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(RUBRIC_THEME.subtle, BACKGROUND)).toBeGreaterThan(
      contrast(RUBRIC_THEME.inactive, BACKGROUND),
    );
    expect(contrast(RUBRIC_THEME.subtle, BACKGROUND)).toBeLessThan(
      contrast(RUBRIC_THEME.text, BACKGROUND),
    );
  });

  it('sets inline code in a warm tone rather than a cool hue', () => {
    // Rubric is a two-colour print: cinnabar marks and ink. A cool accent for
    // code would put a third hue in a warm palette.
    const [red, green, blue] = channels(RUBRIC_THEME.mdInlineCodeText);

    expect(red).toBeGreaterThanOrEqual(green);
    expect(green).toBeGreaterThanOrEqual(blue);
  });

  it('gives every theme a hex userText token', () => {
    const themes: Record<string, ThemeTokens> = {
      DEFAULT_THEME,
      FOLIO_THEME,
      RUBRIC_THEME,
    };

    for (const [name, theme] of Object.entries(themes)) {
      expect(theme.userText, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
