import { canonicalToolName } from './aliases.js';
import { renderDiffWithStatsAsync, type DiffStats } from './diff.js';
import { applySingleEdit } from './file.js';
import { readTextSnapshot, type TextSnapshot } from './mutation.js';
import { applyHunks, parsePatch, type PatchOperation } from './patch.js';
import { resolveWorkspacePath } from './path-utils.js';
import { toolResultErrorMessage } from './result.js';
import type { ToolCall, ToolResult } from '../types/tools.js';

/**
 * Pre-execution preview of what a file-mutating tool call would change.
 *
 * The permission prompt is where the user consents to a mutation, so it has to
 * show the mutation, not just the path it lands on. The tools themselves only
 * produce a diff *after* writing; this module computes the same diff from the
 * pending call's arguments against the file as it is on disk right now, with
 * the same matching semantics the tool will use, and never writes anything.
 *
 * Arguments are read by their canonical names only. The agent loop runs
 * `registry.normalizeCall` on every call before hooks, permission evaluation
 * and the prompt see it (`src/agent/loop.ts`), so the pending call already
 * carries `filePath`, not `file_path`; a host that hands this module a raw
 * provider call must normalize it through the registry first.
 *
 * What is previewed is the textual change. The tools also gate on file
 * provenance (`file_not_observed`, `stale_file_observation`), which lives in
 * the tool context and is not consulted here.
 */

export interface MutationPreviewFile {
  /** Workspace-relative path the tool will write, delete, or create. */
  filePath: string;
  kind: 'create' | 'update' | 'delete';
  /** Unified diff hunks, empty when the change is textually a no-op. */
  diff: string;
  stats: DiffStats;
}

export interface MutationPreview {
  files: MutationPreviewFile[];
  /**
   * Why no preview could be computed. This is the matching or path failure
   * the tool itself would report, surfaced at consent time so the user can
   * decline a call that is going to fail anyway.
   */
  error?: string;
}

/** Per-side line ceiling; the diff is trimmed to the changed span but still bounded here. */
const MAX_PREVIEW_LINES = 20_000;
const TOO_LARGE = 'File is too large to preview';

const PREVIEWABLE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch']);

/** Whether {@link previewMutation} can say anything about this call. */
export function isPreviewableMutation(toolCall: ToolCall): boolean {
  return PREVIEWABLE_TOOLS.has(canonicalToolName(toolCall.name));
}

/** A failure the tool would report; becomes {@link MutationPreview.error}. */
class PreviewError extends Error {}

function fail(message: string): never {
  throw new PreviewError(message);
}

function failWith(result: ToolResult): never {
  return fail(toolResultErrorMessage(result) ?? result.content);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++;
  return count;
}

interface ResolvedTarget {
  filePath: string;
  canonicalPath: string;
  relativePath: string;
}

function resolveTarget(workspaceRoot: string, inputPath: string | undefined): ResolvedTarget {
  if (!inputPath) return fail('No file path given');
  return (
    resolveWorkspacePath(workspaceRoot, inputPath) ?? fail(`Path outside workspace: ${inputPath}`)
  );
}

async function snapshotOf(target: ResolvedTarget, allowMissing: boolean): Promise<TextSnapshot> {
  let snapshot: TextSnapshot;
  try {
    snapshot = await readTextSnapshot(target.filePath, allowMissing);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? fail(`File not found: ${target.relativePath}`)
      : fail(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (snapshot.binary) fail(`Binary file is unsupported: ${target.relativePath}`);
  // Bail before any matching work: every pass below is O(file).
  if (lineCount(snapshot.text) > MAX_PREVIEW_LINES) fail(TOO_LARGE);
  return snapshot;
}

async function diffFile(
  target: ResolvedTarget,
  kind: MutationPreviewFile['kind'],
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<MutationPreviewFile> {
  if (lineCount(after) > MAX_PREVIEW_LINES) fail(TOO_LARGE);
  const { diff, stats } = await renderDiffWithStatsAsync(before, after, 3, signal);
  return { filePath: target.relativePath, kind, diff, stats };
}

async function previewWrite(
  args: Record<string, unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const target = resolveTarget(workspaceRoot, stringArg(args, 'filePath'));
  const content = stringArg(args, 'content') ?? fail('No content given');
  const before = await snapshotOf(target, true);
  const after = before.exists ? content.replace(/\r\n/g, '\n') : content;
  const kind = before.exists ? 'update' : 'create';
  return { files: [await diffFile(target, kind, before.text, after, signal)] };
}

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function editSpec(source: Record<string, unknown>): EditSpec {
  const oldString = stringArg(source, 'oldString');
  const newString = stringArg(source, 'newString');
  if (oldString === undefined || newString === undefined) fail('No edit given');
  return {
    oldString: oldString.replace(/\r\n/g, '\n'),
    newString: newString.replace(/\r\n/g, '\n'),
    replaceAll: source.replaceAll === true,
  };
}

function multiEditSpecs(args: Record<string, unknown>): EditSpec[] {
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) fail('No edits provided');
  return edits.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? editSpec(item as Record<string, unknown>)
      : fail('Malformed edit entry'),
  );
}

async function previewEdits(
  args: Record<string, unknown>,
  edits: EditSpec[],
  atomic: boolean,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const target = resolveTarget(workspaceRoot, stringArg(args, 'filePath'));
  const snapshot = await snapshotOf(target, false);
  if (snapshot.mixedLineEndings)
    fail(
      `Mixed line endings are unsupported for ${atomic ? 'MultiEdit' : 'Edit'}: ${target.relativePath}`,
    );
  let content = snapshot.text;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const application = await applySingleEdit(
      content,
      edit.oldString,
      edit.newString,
      edit.replaceAll,
      signal,
      atomic ? `Edit ${index + 1}: ` : '',
      atomic ? ' (no changes applied — MultiEdit is atomic)' : '',
    );
    if (!application.ok) failWith(application.failure);
    content = application.content;
  }
  return { files: [await diffFile(target, 'update', snapshot.text, content, signal)] };
}

async function previewPatchOperation(
  operation: PatchOperation,
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<MutationPreviewFile> {
  const before = await snapshotOf(target, operation.kind === 'add');
  if (operation.kind === 'add') {
    if (before.exists) fail(`File already exists: ${target.relativePath}`);
    const after = operation.lines.join('\n') + (operation.lines.length > 0 ? '\n' : '');
    return diffFile(target, 'create', '', after, signal);
  }
  if (!before.exists) fail(`File not found: ${target.relativePath}`);
  if (operation.kind === 'delete') return diffFile(target, 'delete', before.text, '', signal);
  if (before.mixedLineEndings)
    fail(`Mixed line endings are unsupported for patch updates: ${target.relativePath}`);
  const applied = applyHunks(before.text, operation.hunks);
  if (applied.mismatch)
    fail(
      `${target.relativePath}: ${toolResultErrorMessage(applied.mismatch) ?? applied.mismatch.content}`,
    );
  return diffFile(target, 'update', before.text, applied.text, signal);
}

async function previewPatch(
  args: Record<string, unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const parsed = parsePatch(args.patch);
  if ('version' in parsed) failWith(parsed);
  const targets = parsed.operations.map((operation) =>
    resolveTarget(workspaceRoot, operation.path),
  );
  // The tool refuses a patch that names one file twice, before touching anything.
  const seen = new Set<string>();
  for (const target of targets) {
    const key =
      process.platform === 'win32' ? target.canonicalPath.toLowerCase() : target.canonicalPath;
    if (seen.has(key)) fail('A patch may contain only one operation per file');
    seen.add(key);
  }
  const files: MutationPreviewFile[] = [];
  for (let index = 0; index < parsed.operations.length; index++) {
    files.push(await previewPatchOperation(parsed.operations[index], targets[index], signal));
  }
  return { files };
}

/**
 * Compute the diff a pending mutation would produce, or `null` when the tool
 * is not one this module understands. Never throws for a bad call: every
 * failure the tool would report comes back as {@link MutationPreview.error}.
 * Only an aborted `signal` rejects.
 */
export async function previewMutation(
  toolCall: ToolCall,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview | null> {
  const args = toolCall.arguments ?? {};
  try {
    switch (canonicalToolName(toolCall.name)) {
      case 'Write':
        return await previewWrite(args, workspaceRoot, signal);
      case 'Edit':
        return await previewEdits(args, [editSpec(args)], false, workspaceRoot, signal);
      case 'MultiEdit':
        return await previewEdits(args, multiEditSpecs(args), true, workspaceRoot, signal);
      case 'ApplyPatch':
        return await previewPatch(args, workspaceRoot, signal);
      default:
        return null;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof PreviewError) return { files: [], error: error.message };
    return {
      files: [],
      error: `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
