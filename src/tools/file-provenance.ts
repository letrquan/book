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

/**
 * An outline shows the model a file's declarations, not its content. It is
 * recorded, but it never stands in for having seen the file: it satisfies
 * neither the observed-file check nor the freshness check below.
 */
function isOutline(observation: FileObservation): boolean {
  return observation.operation === 'outline';
}

/**
 * Whether `next` may take `current`'s place in an observation ledger. An
 * outline never displaces a real observation of the same file, so it cannot
 * refresh the hash a mutation is checked against.
 */
export function mayReplaceObservation(
  current: FileObservation | undefined,
  next: FileObservation,
): boolean {
  return !current || !isOutline(next) || isOutline(current);
}

/**
 * Whether `next` takes `current`'s place when a ledger is rebuilt from recorded
 * observations (a resumed transcript, a checkpoint). A real observation always
 * replaces an outline, and an outline never replaces one, whatever the
 * timestamps: a parallel batch records its results in call order, so an
 * outline that finished after a Read of the same file can come first with the
 * later time. Between two of the same kind, the newer wins.
 */
export function supersedesObservation(
  current: FileObservation | undefined,
  next: FileObservation,
): boolean {
  if (!current) return true;
  if (isOutline(current) !== isOutline(next)) return isOutline(current);
  return current.timestamp <= next.timestamp;
}

/**
 * Rebuild a resumed session's ledger from its transcript under
 * `supersedesObservation`, so it ends where the live ledger did: an outline is
 * still only an outline after a resume, and a Read is still a Read.
 */
export function seedObservationLedger(
  ledger: Map<string, FileObservation>,
  messages: readonly { fileObservations?: readonly FileObservation[] }[],
): Map<string, FileObservation> {
  for (const message of messages) {
    for (const observation of message.fileObservations ?? []) {
      const key = observationKey(observation.workspaceId, observation.path);
      if (supersedesObservation(ledger.get(key), observation)) ledger.set(key, observation);
    }
  }
  return ledger;
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
  const key = observationKey(workspaceId, path);
  const ledger = ctx.fileObservationLedger;
  if (ledger && mayReplaceObservation(ledger.get(key), observation)) ledger.set(key, observation);
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
  if (!remembered || isOutline(remembered)) return undefined;
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
 * mutation; an outline does not count) before it may be mutated. Contexts
 * without an observation ledger (bare harnesses, low-level embedding) are
 * exempt. Returns a ready ToolResult failure so every mutating tool reports the
 * same code and remediation.
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
  const remembered = ledger.get(observationKey(workspaceId, normalizedPath));
  if (remembered && !isOutline(remembered)) return undefined;
  const seen = remembered
    ? "has only been outlined in this session, and an outline is not the file's content"
    : 'has not been read in this session';
  return toolFailure(
    `SKIPPED: ${normalizedPath} ${seen}. Call Read (or mention the file) before modifying it.`,
    {
      code: 'file_not_observed',
      remediation: `Read the file first, then retry the ${retryVerb}.`,
    },
  );
}
