import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The single renderer line the patch rewrites — see patches/ink+6.8.0.patch. */
export const PATCHED_RENDERER_CALL = 'ansiEscapes.cursorUp(previousLines.length - 1)';

/**
 * Locate the ink renderer patch and the ink install it targets, or undefined when either is
 * absent — production tarballs ship neither the patches directory nor a resolvable dev tree.
 */
export function resolveInkPatch(root = process.cwd()) {
  const patchesDir = join(root, 'patches');
  if (!existsSync(patchesDir)) return undefined;

  const patchFile = readdirSync(patchesDir).find(
    (name) => name.startsWith('ink+') && name.endsWith('.patch'),
  );
  if (!patchFile) return undefined;

  let buildDir;
  try {
    buildDir = dirname(require.resolve('ink'));
  } catch {
    return undefined;
  }

  return {
    patchPath: join(patchesDir, patchFile),
    patchFile,
    patchedVersion: patchFile.slice('ink+'.length, -'.patch'.length),
    installedVersion: JSON.parse(readFileSync(join(buildDir, '..', 'package.json'), 'utf8'))
      .version,
    logUpdatePath: join(buildDir, 'log-update.js'),
  };
}

/**
 * patch-package matches patches by package name alone, so `ink+6.8.0.patch` still applies to a
 * later ink and downgrades the version mismatch to a warning. Pin the version so a bump fails
 * instead of silently grafting the 6.8 renderer fix onto a renderer it was never written for.
 */
export function assertInkVersionMatchesPatch({ patchFile, patchedVersion, installedVersion }) {
  if (installedVersion === patchedVersion) return;
  throw new Error(
    `Ink renderer patch targets ink@${patchedVersion} but ink@${installedVersion} is installed.\n` +
      `patch-package only warns about this and applies the patch anyway.\n` +
      `Re-verify TUI rendering against ink@${installedVersion}, then run \`npx patch-package ink\` ` +
      `to retarget ${patchFile}.`,
  );
}

export function assertRendererPatchApplied({ patchedVersion, logUpdatePath }) {
  const source = readFileSync(logUpdatePath, 'utf8');
  if (source.includes(PATCHED_RENDERER_CALL)) return;
  throw new Error(`Ink ${patchedVersion} renderer patch is missing from ${logUpdatePath}`);
}
