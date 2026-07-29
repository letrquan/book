import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const patchPath = join(root, 'patches', 'ink+6.8.0.patch');
if (!existsSync(patchPath)) process.exit(0);

const require = createRequire(import.meta.url);
let patchPackagePath;
try {
  patchPackagePath = require.resolve('patch-package');
} catch {
  // Production tarballs do not include devDependencies; their install must remain usable.
  process.exit(0);
}

const result = spawnSync(process.execPath, [patchPackagePath], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const logUpdatePath = join(dirname(require.resolve('ink')), 'log-update.js');
const source = readFileSync(logUpdatePath, 'utf8');
if (!source.includes('ansiEscapes.cursorUp(previousLines.length - 1)')) {
  throw new Error(`Ink 6.8 renderer patch is missing from ${logUpdatePath}`);
}
