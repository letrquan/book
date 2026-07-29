import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const logUpdatePath = join(dirname(require.resolve('ink')), 'log-update.js');
const source = readFileSync(logUpdatePath, 'utf8');
const expected = 'ansiEscapes.cursorUp(previousLines.length - 1)';

if (!source.includes(expected)) {
  throw new Error(`Ink 6.8 renderer patch is missing from ${logUpdatePath}`);
}
