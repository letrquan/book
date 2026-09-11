import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import { loadInteractiveAssets } from './interactive-assets.js';
import { APPLE_THEME } from './theme.js';

let workspace: string | undefined;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

function assetsFor(theme?: string) {
  workspace = mkdtempSync(join(tmpdir(), 'book-interactive-assets-'));
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (theme !== undefined) settings.theme = theme;
  return loadInteractiveAssets({ workspace, settings });
}

describe('loadInteractiveAssets initial theme', () => {
  it('opens a fresh install on the apple palette', () => {
    const { initialTheme } = assetsFor();

    expect(initialTheme?.resolvedName).toBe('apple');
    expect(initialTheme?.tokens).toBe(APPLE_THEME);
  });

  it('honours an explicit theme setting for apple', () => {
    const { initialTheme } = assetsFor('apple');

    expect(initialTheme?.resolvedName).toBe('apple');
    expect(initialTheme?.tokens).toBe(APPLE_THEME);
  });

  it('reports an unknown or removed theme as unresolved instead of falling back silently', () => {
    // The App owns the fallback; the loader must not paper over a typo in
    // settings by quietly substituting the default.
    expect(assetsFor('dark').initialTheme).toBeNull();
    expect(assetsFor('no-such-theme').initialTheme).toBeNull();
  });
});
