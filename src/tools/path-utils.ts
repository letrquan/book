import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { ReadOnlyRoot, ToolResult } from '../types/tools.js';
import { toolFailure } from './result.js';

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function nearestExistingPath(inputPath: string): string | null {
  let candidate = inputPath;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): { filePath: string; canonicalPath: string; relativePath: string } | null {
  const lexicalRoot = resolve(workspaceRoot);
  const filePath = resolve(isAbsolute(inputPath) ? inputPath : resolve(lexicalRoot, inputPath));
  if (isOutside(lexicalRoot, filePath)) return null;

  const existingPath = nearestExistingPath(filePath);
  if (!existingPath) return null;

  let realRoot: string;
  let realExisting: string;
  try {
    realRoot = realpathSync.native(lexicalRoot);
    realExisting = realpathSync.native(existingPath);
  } catch {
    return null;
  }
  if (isOutside(realRoot, realExisting)) return null;

  const canonicalPath = resolve(realExisting, relative(existingPath, filePath));
  if (isOutside(realRoot, canonicalPath)) return null;

  const rel = relative(lexicalRoot, filePath);
  return { filePath, canonicalPath, relativePath: rel.replace(/\\/g, '/') };
}

export interface ResolvedReadablePath {
  filePath: string;
  canonicalPath: string;
  relativePath: string;
}

/**
 * Whether a resolved path falls under an excluded subpath of a read-only root (the memory
 * inbox). Checked on the canonical path — after symlinks — and case-folded where the file
 * system folds case, so `.INBOX/` or a link into `.inbox` cannot slip past it.
 */
function isExcludedPath(
  canonicalPath: string,
  roots: readonly (string | ReadOnlyRoot)[] | undefined,
): boolean {
  const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
  const target = fold(canonicalPath);
  for (const entry of roots ?? []) {
    if (typeof entry === 'string' || !entry.exclude?.length) continue;
    let base: string;
    try {
      base = realpathSync.native(entry.root);
    } catch {
      base = resolve(entry.root);
    }
    for (const sub of entry.exclude) {
      const dir = fold(join(base, sub));
      if (target === dir || target.startsWith(`${dir}${sep}`)) return true;
    }
  }
  return false;
}

export function resolveReadablePath(
  context: { workspaceRoot: string; readOnlyRoots?: readonly (string | ReadOnlyRoot)[] },
  inputPath: string,
): ResolvedReadablePath | null {
  const pick = (match: ReturnType<typeof resolveWorkspacePath>): ResolvedReadablePath | null =>
    match && !isExcludedPath(match.canonicalPath, context.readOnlyRoots)
      ? {
          filePath: match.filePath,
          canonicalPath: match.canonicalPath,
          relativePath: match.relativePath,
        }
      : null;

  // The exclusion applies whichever root matched: a memory directory inside the workspace
  // (running in $HOME) must not expose its inbox through the workspace branch.
  const wsMatch = resolveWorkspacePath(context.workspaceRoot, inputPath);
  if (wsMatch) return pick(wsMatch);

  // Only absolute inputs may be tried against read-only roots; relative inputs stay workspace-anchored.
  if (!isAbsolute(inputPath)) return null;
  for (const entry of context.readOnlyRoots ?? []) {
    const root = typeof entry === 'string' ? entry : entry.root;
    const match = resolveWorkspacePath(root, inputPath);
    if (match) return pick(match);
  }
  return null;
}

export function pathOutsideWorkspaceResult(inputPath: unknown): ToolResult {
  return toolFailure(`Path outside workspace: ${inputPath}`, {
    code: 'path_outside_workspace',
  });
}
