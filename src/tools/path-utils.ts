import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import type { ToolResult } from '../types/tools.js';
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

export function pathOutsideWorkspaceResult(inputPath: unknown): ToolResult {
  return toolFailure(`Path outside workspace: ${inputPath}`, {
    code: 'path_outside_workspace',
  });
}
