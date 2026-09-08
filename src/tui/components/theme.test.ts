import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  APPLE_THEME,
  DARK_THEME,
  LIGHT_THEME,
  CATPPUCCIN_THEME,
  NORD_THEME,
  GRUVBOX_THEME,
  SOLARIZED_DARK_THEME,
  hasLightTerminalBackground,
  listCustomThemes,
  loadCustomTheme,
  resolveTheme,
} from '../theme.js';
import { DEFAULT_THEME } from '../../types/theme.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-theme-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadCustomTheme', () => {
  it('returns null when no theme file exists', () => {
    expect(loadCustomTheme(dir, 'nonexistent')).toBeNull();
  });

  it('loads a custom theme and merges with defaults', () => {
    const themesDir = join(dir, '.book', 'themes');
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(
      join(themesDir, 'test-theme.json'),
      JSON.stringify({ brand: '#ff0000', text: '#ffffff' }),
    );

    const theme = loadCustomTheme(dir, 'test-theme');
    expect(theme).not.toBeNull();
    expect(theme!.brand).toBe('#ff0000');
    expect(theme!.text).toBe('#ffffff');
    // Unspecified keys retain defaults.
    expect(theme!.error).toBe(DEFAULT_THEME.error);
    expect(theme!.surface).toBe(DEFAULT_THEME.surface);
  });

  it('returns null on malformed JSON', () => {
    const themesDir = join(dir, '.book', 'themes');
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(join(themesDir, 'bad.json'), '{not json');

    expect(loadCustomTheme(dir, 'bad')).toBeNull();
  });

  it('rejects names that could escape the themes directory', () => {
    expect(loadCustomTheme(dir, '../outside')).toBeNull();
  });
});

describe('theme resolution', () => {
  it('detects the background from the final COLORFGBG value', () => {
    expect(hasLightTerminalBackground('15;0')).toBe(false);
    expect(hasLightTerminalBackground('0;15')).toBe(true);
    expect(hasLightTerminalBackground('0;7')).toBe(true);
  });

  it('resolves built-ins and auto mode', () => {
    expect(resolveTheme(dir, 'apple')?.tokens).toBe(APPLE_THEME);
    expect(resolveTheme(dir, 'apple-dark')?.tokens).toBe(APPLE_THEME);
    expect(resolveTheme(dir, 'dark')?.tokens).toBe(DARK_THEME);
    expect(resolveTheme(dir, 'LIGHT')?.tokens).toBe(LIGHT_THEME);
    expect(resolveTheme(dir, 'auto', '0;15')?.resolvedName).toBe('light');
    // A dark terminal under `auto` gets the same palette as a fresh install.
    expect(resolveTheme(dir, 'auto', '15;0')?.resolvedName).toBe('apple');
    expect(resolveTheme(dir, 'auto', '15;0')?.tokens).toBe(APPLE_THEME);
    expect(resolveTheme(dir, 'catppuccin')?.tokens).toBe(CATPPUCCIN_THEME);
    expect(resolveTheme(dir, 'catppuccin-mocha')?.tokens).toBe(CATPPUCCIN_THEME);
    expect(resolveTheme(dir, 'mocha')?.tokens).toBe(CATPPUCCIN_THEME);
    expect(resolveTheme(dir, 'nord')?.tokens).toBe(NORD_THEME);
    expect(resolveTheme(dir, 'gruvbox')?.tokens).toBe(GRUVBOX_THEME);
    expect(resolveTheme(dir, 'gruvbox-dark')?.tokens).toBe(GRUVBOX_THEME);
    expect(resolveTheme(dir, 'solarized-dark')?.tokens).toBe(SOLARIZED_DARK_THEME);
    expect(resolveTheme(dir, 'solarized')?.tokens).toBe(SOLARIZED_DARK_THEME);
  });

  it('lists and resolves project themes', () => {
    const themesDir = join(dir, '.book', 'themes');
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(join(themesDir, 'paper-ink.json'), JSON.stringify({ brand: '#123456' }));
    writeFileSync(join(themesDir, 'bad name.json'), JSON.stringify({ brand: '#abcdef' }));

    expect(listCustomThemes(dir)).toEqual(['paper-ink']);
    expect(resolveTheme(dir, 'paper-ink')?.tokens.brand).toBe('#123456');
    expect(resolveTheme(dir, 'missing')).toBeNull();
  });
});

describe('built-in editorial themes', () => {
  // Clay is deliberately shared by `brand` and `userAccent`: it is one warm
  // accent used in two contexts (product chrome and user-authored content),
  // which never carry competing meaning on the same row.
  const DISTINCT_ROLES = [
    'text',
    'brand',
    'assistantAccent',
    'mdLink',
    'success',
    'error',
    'warning',
    'planMode',
    'modeDefault',
  ] as const;

  for (const [name, theme] of [
    ['apple', APPLE_THEME],
    ['dark', DARK_THEME],
    ['light', LIGHT_THEME],
    ['catppuccin', CATPPUCCIN_THEME],
    ['nord', NORD_THEME],
    ['gruvbox', GRUVBOX_THEME],
    ['solarized-dark', SOLARIZED_DARK_THEME],
  ] as const) {
    it(`gives every ${name} role its own hue`, () => {
      const used = new Map<string, string>();
      for (const role of DISTINCT_ROLES) {
        const hex = theme[role];
        expect(used.has(hex), `${role} reuses the hue of ${used.get(hex)} (${hex})`).toBe(false);
        used.set(hex, role);
      }
    });

    it(`keeps the ${name} spinner on the agent's own hue`, () => {
      // The spinner is the agent speaking, so its gradient is anchored on
      // `assistantAccent` and eases to a lighter tint of the same hue. `brand`
      // is product chrome — the plan header and the plan's active step — and
      // the two sit on adjacent rows in the footer. A breath that lands on
      // `brand` erases the difference between the run talking and the UI
      // labelling it, which is the whole reason the activity row stopped using
      // `text`. Nord shipped this pair transposed and Catppuccin ended it on
      // `brand`; in both, the working line rendered in the plan's colour.
      const [from, to] = theme.shimmerPair;
      expect(from).toBe(theme.assistantAccent);
      expect(from).not.toBe(theme.brand);
      expect(to).not.toBe(theme.brand);
    });

    it(`keeps ${name} prose headings out of the chrome palette`, () => {
      // A heading that matches brand or the agent accent makes body copy read
      // as UI chrome, which is what the single-hue palette used to do.
      expect(theme.mdHeadingH1).not.toBe(theme.brand);
      expect(theme.mdHeadingH1).not.toBe(theme.assistantAccent);
      expect(theme.usageMeter).not.toBe(theme.brand);
    });

    it(`ranks ${name} heading depth by three distinct steps`, () => {
      // Headings carry no `###` marker or side rule any more, so depth is
      // legible only through this ramp. If two steps collapse — or one matches
      // `text` — a heading becomes indistinguishable from a bold run of body
      // copy, which is exactly what H1 did when it was set to `text`.
      const ramp = [theme.mdHeadingH1, theme.mdHeadingH2, theme.mdHeading];
      expect(new Set(ramp).size).toBe(3);
      // No step may sit at `text`. A heading that matches body copy is carried
      // by bold alone, which is the weakest signal in a terminal and reads as
      // an emphasised sentence rather than a section.
      for (const step of ramp) expect(step).not.toBe(theme.text);
    });
  }

  it('anchors the warm editorial identity', () => {
    expect(DARK_THEME.text).toBe('#E7E1D4');
    expect(DARK_THEME.assistantAccent).toBe('#AFC19D');
    expect(LIGHT_THEME.text).toBe('#302E2A');
    expect(LIGHT_THEME.assistantAccent).toBe('#607257');
  });

  it('keeps the apple palette neutral except for the action accent', () => {
    // The whole point of the default palette is that ordinary chrome is grey:
    // the composer frame and user input are the one blue, the agent speaks in
    // cyan, and every other saturated hue is a status that needs attention.
    // `default` mode in particular must carry no colour of its own.
    expect(APPLE_THEME.promptBorder).toBe(APPLE_THEME.userAccent);
    expect(APPLE_THEME.modeDefault).toBe(APPLE_THEME.subtle);
    for (const role of ['border', 'toolRail', 'inactive', 'subtle', 'suggestion'] as const) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(APPLE_THEME[role].slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${role} is not neutral`).toBeLessThan(8);
    }
  });
});
