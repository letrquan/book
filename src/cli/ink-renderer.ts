import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The Ink release whose renderer Book's TUI was last verified against. A dependency bump changes
 * `package.json` but not this constant, so the contract test and `npm run verify:ink` fail until
 * someone re-verifies the TUI (docs/guide/development.md, "Upgrading Ink") and updates it.
 */
export const VERIFIED_INK_VERSION = '7.1.1';

/**
 * The incremental renderer's cursor rewind with Ink's trailing-newline fix (upstream issue 909,
 * shipped in Ink 7.0.0). Without it, a frame that ends in a newline rewinds one row short and
 * later updates land below their rows.
 */
export const INK_TRAILING_NEWLINE_FIX = 'ansiEscapes.cursorUp(previousLines.length - 1)';

function inkBuildDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('ink'));
}

/** The installed Ink version, or undefined when Ink cannot be resolved. */
export function installedInkVersion(): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(inkBuildDir(), '..', 'package.json'), 'utf8'),
    ) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Incremental rendering is safe only when Ink's renderer carries the trailing-newline fix. */
export function hasInkTrailingNewlineFix(): boolean {
  try {
    return readFileSync(join(inkBuildDir(), 'log-update.js'), 'utf8').includes(
      INK_TRAILING_NEWLINE_FIX,
    );
  } catch {
    return false;
  }
}
