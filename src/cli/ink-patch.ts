import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const INK_PATCH_MARKER = 'ansiEscapes.cursorUp(previousLines.length - 1)';

/** Incremental rendering is safe only when the Ink trailing-newline patch is present. */
export function isInkIncrementalRendererPatched(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const logUpdatePath = join(dirname(require.resolve('ink')), 'log-update.js');
    return readFileSync(logUpdatePath, 'utf8').includes(INK_PATCH_MARKER);
  } catch {
    return false;
  }
}
