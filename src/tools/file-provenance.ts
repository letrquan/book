import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { normalize, relative, resolve } from 'path';
import type { FileObservation, FileObservationOperation, ToolContext } from '../types.js';

export function workspaceIdentity(workspaceRoot: string): string {
  const root = normalize(resolve(workspaceRoot));
  const stable = process.platform === 'win32' ? root.toLowerCase() : root;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

export function observationKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path.replace(/\\/g, '/')}`;
}

export async function observeFile(
  ctx: ToolContext,
  absolutePath: string,
  operation: FileObservationOperation,
  coverage?: { lineStart?: number; lineEnd?: number },
): Promise<FileObservation> {
  const bytes = await readFile(absolutePath);
  const workspaceId = workspaceIdentity(ctx.workspaceRoot);
  const path = relative(resolve(ctx.workspaceRoot), absolutePath).replace(/\\/g, '/');
  const observation: FileObservation = {
    path,
    workspaceId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    lineStart: coverage?.lineStart,
    lineEnd: coverage?.lineEnd,
    operation,
    sourceRef: ctx.currentToolTraceId ?? 'runtime-tool',
    timestamp: Date.now(),
  };
  ctx.fileObservationLedger?.set(observationKey(workspaceId, path), observation);
  return observation;
}

export async function requireFreshObservation(
  ctx: ToolContext,
  absolutePath: string,
  relativePath: string,
): Promise<string | undefined> {
  const workspaceId = workspaceIdentity(ctx.workspaceRoot);
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const remembered = ctx.fileObservationLedger?.get(observationKey(workspaceId, normalizedPath));
  if (!remembered) return undefined;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return staleMessage(normalizedPath);
    const bytes = await readFile(absolutePath);
    const currentHash = createHash('sha256').update(bytes).digest('hex');
    return currentHash === remembered.sha256 ? undefined : staleMessage(normalizedPath);
  } catch {
    return staleMessage(normalizedPath);
  }
}

function staleMessage(path: string): string {
  return `SKIPPED: ${path} changed or disappeared since it was last shown to the model. Call Read (or mention the file again) before modifying it.`;
}
