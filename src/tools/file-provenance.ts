import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { normalize, relative, resolve } from 'path';
import type {
  FileObservation,
  FileObservationOperation,
  ToolContext,
  ToolResult,
} from '../types/tools.js';
import { canonicalizePath } from './path-utils.js';
import { toolFailure } from './result.js';

export function workspaceIdentity(workspaceRoot: string): string {
  const root = normalize(resolve(workspaceRoot));
  const stable = process.platform === 'win32' ? root.toLowerCase() : root;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

/**
 * A path as observations and checkpoint files are matched on: forward slashes, and on
 * case-insensitive filesystems (Windows) one spelling for every casing of the same file,
 * mirroring workspaceIdentity's root folding. A matching key only; never display it.
 */
export function normalizeObservedPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function observationKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${normalizeObservedPath(path)}`;
}

/**
 * The path an observation is filed and looked up under: the file's position relative to the
 * workspace root, with links followed on **both** sides.
 *
 * The two ends of the ledger have to derive this one way. `resolveWorkspacePath` reports a
 * workspace file relative to the root *after* links whenever the path was not written inside the
 * root as given (`asWrittenInside`), so a workspace root reached through a symlink — or typed in
 * 8.3 short form, which is the same disagreement on Windows — makes a lexical
 * `relative(resolve(workspaceRoot), absolutePath)` name a *different* file: the Read filed
 * `../real/a.txt` and the Edit looked up `a.txt`, so the write answered `file_not_observed`
 * (PR #334 finding 6). Canonicalizing both sides is the one spelling under which the two agree,
 * and it is the one the resolution has already committed to.
 *
 * A file in an honored root keeps its `../` prefix, because an honored root is outside the
 * workspace either way: that is what keeps `notes.txt` in `/srv/app` and `notes.txt` in the
 * workspace from sharing a ledger entry.
 */
export function observationPathFor(workspaceRoot: string, absolutePath: string): string {
  const root = canonicalizePath(resolve(workspaceRoot));
  return relative(root, canonicalizePath(absolutePath)).replace(/\\/g, '/');
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
  const path = observationPathFor(ctx.workspaceRoot, absolutePath);
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
  // Looked up by the same derivation `observeFile` filed it under, not by the display spelling:
  // the two are the same file spelled two ways whenever the workspace root is itself reached
  // through a link (PR #334 finding 6). `relativePath` is still what the message names, because
  // that is the spelling the model wrote.
  const remembered = ctx.fileObservationLedger?.get(
    observationKey(workspaceId, observationPathFor(ctx.workspaceRoot, absolutePath)),
  );
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
 *
 * Keyed on `absolutePath` through {@link observationPathFor}, the way the observation was filed —
 * `relativePath` is the display spelling and can be the other spelling of the same file. It
 * names the file in the message either way.
 */
export function requireObservationForMutation(
  ctx: ToolContext,
  absolutePath: string,
  relativePath: string,
  retryVerb: string,
): ToolResult | undefined {
  const ledger = ctx.fileObservationLedger;
  if (!ledger) return undefined;
  const workspaceId = workspaceIdentity(ctx.workspaceRoot);
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const remembered = ledger.get(
    observationKey(workspaceId, observationPathFor(ctx.workspaceRoot, absolutePath)),
  );
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
