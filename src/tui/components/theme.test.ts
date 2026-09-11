import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { APPLE_THEME, listCustomThemes, loadCustomTheme, resolveTheme } from '../theme.js';
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
  it('resolves apple and reports other or unknown themes as null', () => {
    expect(resolveTheme(dir, 'apple')?.tokens).toBe(APPLE_THEME);
    expect(resolveTheme(dir, 'apple-dark')?.tokens).toBe(APPLE_THEME);
    expect(resolveTheme(dir, 'dark')).toBeNull();
    expect(resolveTheme(dir, 'light')).toBeNull();
    expect(resolveTheme(dir, 'auto')).toBeNull();
    expect(resolveTheme(dir, 'catppuccin')).toBeNull();
    expect(resolveTheme(dir, 'nord')).toBeNull();
    expect(resolveTheme(dir, 'gruvbox')).toBeNull();
    expect(resolveTheme(dir, 'solarized-dark')).toBeNull();
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

describe('apple default theme', () => {
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

  for (const [name, theme] of [['apple', APPLE_THEME]] as const) {
    it(`gives every ${name} role its own hue`, () => {
      const used = new Map<string, string>();
      for (const role of DISTINCT_ROLES) {
        const hex = theme[role];
        expect(used.has(hex), `${role} reuses the hue of ${used.get(hex)} (${hex})`).toBe(false);
        used.set(hex, role);
      }
    });

    it(`keeps the ${name} spinner on the agent's own hue`, () => {
      const [from, to] = theme.shimmerPair;
      expect(from).toBe(theme.assistantAccent);
      expect(from).not.toBe(theme.brand);
      expect(to).not.toBe(theme.brand);
    });

    it(`keeps ${name} prose headings out of the chrome palette`, () => {
      expect(theme.mdHeadingH1).not.toBe(theme.brand);
      expect(theme.mdHeadingH1).not.toBe(theme.assistantAccent);
      expect(theme.usageMeter).not.toBe(theme.brand);
    });

    it(`ranks ${name} heading depth by three distinct steps`, () => {
      const ramp = [theme.mdHeadingH1, theme.mdHeadingH2, theme.mdHeading];
      expect(new Set(ramp).size).toBe(3);
      for (const step of ramp) expect(step).not.toBe(theme.text);
    });
  }

  it('keeps the apple palette neutral except for the action accent', () => {
    expect(APPLE_THEME.promptBorder).toBe(APPLE_THEME.userAccent);
    expect(APPLE_THEME.modeDefault).toBe(APPLE_THEME.subtle);
    for (const role of ['border', 'toolRail', 'inactive', 'subtle', 'suggestion'] as const) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(APPLE_THEME[role].slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${role} is not neutral`).toBeLessThan(8);
    }
  });
});
