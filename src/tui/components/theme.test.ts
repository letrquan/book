import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCustomTheme } from '../theme.js';
import { DEFAULT_THEME } from '../../types.js';

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
  });

  it('returns null on malformed JSON', () => {
    const themesDir = join(dir, '.book', 'themes');
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(join(themesDir, 'bad.json'), '{not json');

    expect(loadCustomTheme(dir, 'bad')).toBeNull();
  });
});
