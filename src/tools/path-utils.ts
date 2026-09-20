import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
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

export function resolveReadablePath(
  context: { workspaceRoot: string; readOnlyRoots?: readonly (string | ReadOnlyRoot)[] },
  inputPath: string,
): ResolvedReadablePath | null {
  const wsMatch = resolveWorkspacePath(context.workspaceRoot, inputPath);
  if (wsMatch) {
    return {
      filePath: wsMatch.filePath,
      canonicalPath: wsMatch.canonicalPath,
      relativePath: wsMatch.relativePath,
    };
  }

  // Only absolute inputs may be tried against read-only roots; relative inputs stay workspace-anchored.
  if (!isAbsolute(inputPath)) {
    return null;
  }

  for (const entry of context.readOnlyRoots ?? []) {
    const root = typeof entry === 'string' ? entry : entry.root;
    const exclude = typeof entry === 'string' ? undefined : entry.exclude;
    const rootMatch = resolveWorkspacePath(root, inputPath);
    if (rootMatch) {
      if (exclude && exclude.length > 0) {
        const isExcluded = exclude.some((subpath) => {
          const normSub = subpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
          const normRel = rootMatch.relativePath;
          return normRel === normSub || normRel.startsWith(`${normSub}/`);
        });
        if (isExcluded) continue;
      }
      return {
        filePath: rootMatch.filePath,
        canonicalPath: rootMatch.canonicalPath,
        relativePath: rootMatch.relativePath,
      };
    }
  }

  return null;
}

export function pathOutsideWorkspaceResult(inputPath: unknown): ToolResult {
  return toolFailure(`Path outside workspace: ${inputPath}`, {
    code: 'path_outside_workspace',
  });
}
