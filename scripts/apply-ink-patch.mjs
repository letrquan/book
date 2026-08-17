import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  assertInkVersionMatchesPatch,
  assertRendererPatchApplied,
  resolveInkPatch,
} from './ink-patch.mjs';

const patch = resolveInkPatch();
if (!patch) process.exit(0);

const require = createRequire(import.meta.url);
let patchPackagePath;
try {
  patchPackagePath = require.resolve('patch-package');
} catch {
  // Production tarballs do not include devDependencies; their install must remain usable.
  process.exit(0);
}

// Checked before patch-package runs, because patch-package itself only warns on a version
// mismatch and applies the patch regardless.
assertInkVersionMatchesPatch(patch);

const result = spawnSync(process.execPath, [patchPackagePath], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

assertRendererPatchApplied(patch);
