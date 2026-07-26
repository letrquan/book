import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { normalize, relative, resolve } from 'path';
import type {
  FileObservation,
  FileObservationOperation,
  ToolContext,
  ToolResult,
} from '../types/tools.js';
import { toolFailure } from './result.js';

export function workspaceIdentity(workspaceRoot: string): string {
  const root = normalize(resolve(workspaceRoot));
  const stable = process.platform === 'win32' ? root.toLowerCase() : root;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

export function observationKey(workspaceId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/');
  // Case-insensitive filesystems (Windows) must key differently-cased spellings
  // of the same file identically, mirroring workspaceIdentity's root folding.
  return `${workspaceId}:${process.platform === 'win32' ? normalized.toLowerCase() : normalized}`;
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

/**
 * Require that the file was observed this session (Read, mention, or a prior
 * mutation) before it may be mutated. Contexts without an observation ledger
 * (bare harnesses, low-level embedding) are exempt. Returns a ready ToolResult
 * failure so every mutating tool reports the same code and remediation.
 */
export function requireObservationForMutation(
  ctx: ToolContext,
  relativePath: string,
  retryVerb: string,
): ToolResult | undefined {
  const ledger = ctx.fileObservationLedger;
  if (!ledger) return undefined;
  const workspaceId = workspaceIdentity(ctx.workspaceRoot);
  const normalizedPath = relativePath.replace(/\\/g, '/');
  if (ledger.has(observationKey(workspaceId, normalizedPath))) return undefined;
  return toolFailure(
    `SKIPPED: ${normalizedPath} has not been read in this session. Call Read (or mention the file) before modifying it.`,
    {
      code: 'file_not_observed',
      remediation: `Read the file first, then retry the ${retryVerb}.`,
    },
  );
}
