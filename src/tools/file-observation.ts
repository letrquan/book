import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import type {
  FileObservation,
  FileObservationCoverage,
  FileObservationLedger,
  ToolContext,
} from '../types.js';

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function workspaceIdentity(workspaceRoot: string): string {
  const canonical = canonicalWorkspaceRoot(workspaceRoot);
  const platformNormalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return `workspace:${createHash('sha256').update(platformNormalized).digest('hex')}`;
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function createTextFileObservation(options: {
  workspaceRoot: string;
  path: string;
  content: string;
  coverage?: FileObservationCoverage;
  operation: FileObservation['operation'];
  sourceRef: string;
}): FileObservation {
  return {
    workspaceIdentity: workspaceIdentity(options.workspaceRoot),
    path: options.path.replace(/\\/g, '/').replace(/^\.\//, ''),
    sha256: sha256Text(options.content),
    sizeBytes: Buffer.byteLength(options.content, 'utf-8'),
    coverage: options.coverage ?? { kind: 'full' },
    operation: options.operation,
    sourceRef: options.sourceRef,
  };
}

export function createFileObservationLedger(
  seed: Iterable<FileObservation> = [],
): FileObservationLedger {
  const entries = new Map<string, FileObservation>();
  const ledger: FileObservationLedger = {
    remember(observation) {
      entries.set(pathKey(observation.path), observation);
    },
    latest(path) {
      return entries.get(pathKey(path));
    },
    all() {
      return Array.from(entries.values());
    },
  };
  for (const observation of seed) ledger.remember(observation);
  return ledger;
}

export function observationsFromMessages(
  messages: Array<{
    fileObservations?: FileObservation[];
    toolResults?: Array<{ fileObservations?: FileObservation[] }>;
  }>,
): FileObservation[] {
  const observations: FileObservation[] = [];
  for (const message of messages) {
    observations.push(...(message.fileObservations ?? []));
    for (const result of message.toolResults ?? []) {
      observations.push(...(result.fileObservations ?? []));
    }
  }
  return observations;
}

export function rememberFileObservations(
  context: Pick<ToolContext, 'fileObservations'>,
  observations: FileObservation[],
): void {
  for (const observation of observations) context.fileObservations?.remember(observation);
}

export function toolObservationSource(context: Pick<ToolContext, 'currentToolTraceId'>): string {
  const traceId = context.currentToolTraceId;
  if (!traceId) return 'tool://current/unknown';
  if (traceId.startsWith('session://current/event/')) return traceId;
  return `tool://current/${encodeURIComponent(traceId)}`;
}

/**
 * Return an actionable error only when a remembered observation exists and is no longer current.
 * No remembered observation deliberately preserves the existing mutation behavior.
 */
export function staleMutationError(
  context: Pick<ToolContext, 'workspaceRoot' | 'fileObservations'>,
  path: string,
  currentContent: string | null,
): string | undefined {
  const remembered = context.fileObservations?.latest(path);
  if (!remembered) return undefined;

  const currentWorkspace = workspaceIdentity(context.workspaceRoot);
  if (remembered.workspaceIdentity !== currentWorkspace) {
    return `File observation is from a different workspace: ${path}. Read the file in the current workspace before modifying it.`;
  }

  const currentHash = currentContent === null ? null : sha256Text(currentContent);
  if (currentHash !== remembered.sha256) {
    return `File changed since it was last observed: ${path}. Read the file again before modifying it.`;
  }
  return undefined;
}
