import { canonicalToolName } from './aliases.js';
import { renderDiffWithStatsAsync, type DiffStats } from './diff.js';
import { applySingleEdit } from './file.js';
import { readTextSnapshot, type TextSnapshot } from './mutation.js';
import { applyHunks, parsePatch } from './patch.js';
import { resolveWorkspacePath } from './path-utils.js';
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
 * Arguments arrive here before the registry applies argument aliases (the
 * prompt is raised ahead of execution), so every model-facing spelling is
 * accepted alongside the canonical one.
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
   * Why no preview could be computed. This is the failure the tool itself
   * would report, surfaced at consent time so the user can decline a call
   * that is going to fail anyway.
   */
  error?: string;
}

/** Per-side line ceiling: the LCS table is O(n·m) and this runs on the UI thread. */
const MAX_PREVIEW_LINES = 20_000;

const PREVIEWABLE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch']);

/** Whether {@link previewMutation} can say anything about this call. */
export function isPreviewableMutation(toolCall: ToolCall): boolean {
  return PREVIEWABLE_TOOLS.has(canonicalToolName(toolCall.name));
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function booleanArg(args: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function failureMessage(result: ToolResult): string {
  return result.structuredError?.message ?? result.content;
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++;
  return count;
}

function tooLarge(before: string, after: string): boolean {
  return lineCount(before) > MAX_PREVIEW_LINES || lineCount(after) > MAX_PREVIEW_LINES;
}

async function diffFile(
  filePath: string,
  kind: MutationPreviewFile['kind'],
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<MutationPreviewFile> {
  const { diff, stats } = await renderDiffWithStatsAsync(before, after, 3, signal);
  return { filePath, kind, diff, stats };
}

interface ResolvedTarget {
  filePath: string;
  relativePath: string;
}

function resolveTarget(
  workspaceRoot: string,
  inputPath: string | undefined,
): ResolvedTarget | string {
  if (!inputPath) return 'No file path given';
  const resolved = resolveWorkspacePath(workspaceRoot, inputPath);
  if (!resolved) return `Path outside workspace: ${inputPath}`;
  return { filePath: resolved.filePath, relativePath: resolved.relativePath };
}

async function snapshotOf(
  target: ResolvedTarget,
  allowMissing: boolean,
): Promise<TextSnapshot | string> {
  let snapshot: TextSnapshot;
  try {
    snapshot = await readTextSnapshot(target.filePath, allowMissing);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? `File not found: ${target.relativePath}`
      : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (snapshot.binary) return `Binary file is unsupported: ${target.relativePath}`;
  return snapshot;
}

async function previewWrite(
  args: Record<string, unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const target = resolveTarget(workspaceRoot, stringArg(args, 'filePath', 'file_path'));
  if (typeof target === 'string') return { files: [], error: target };
  const content = stringArg(args, 'content');
  if (content === undefined) return { files: [], error: 'No content given' };
  const before = await snapshotOf(target, true);
  if (typeof before === 'string') return { files: [], error: before };
  const after = before.exists ? content.replace(/\r\n/g, '\n') : content;
  if (tooLarge(before.text, after)) return { files: [], error: 'File is too large to preview' };
  return {
    files: [
      await diffFile(
        target.relativePath,
        before.exists ? 'update' : 'create',
        before.text,
        after,
        signal,
      ),
    ],
  };
}

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function editSpec(source: Record<string, unknown>): EditSpec | undefined {
  const oldString = stringArg(source, 'oldString', 'old_string');
  const newString = stringArg(source, 'newString', 'new_string');
  if (oldString === undefined || newString === undefined) return undefined;
  return {
    oldString: oldString.replace(/\r\n/g, '\n'),
    newString: newString.replace(/\r\n/g, '\n'),
    replaceAll: booleanArg(source, 'replaceAll', 'replace_all'),
  };
}

async function previewEdits(
  args: Record<string, unknown>,
  edits: EditSpec[],
  atomic: boolean,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const target = resolveTarget(workspaceRoot, stringArg(args, 'filePath', 'file_path'));
  if (typeof target === 'string') return { files: [], error: target };
  if (edits.length === 0) return { files: [], error: 'No edits provided' };
  const snapshot = await snapshotOf(target, false);
  if (typeof snapshot === 'string') return { files: [], error: snapshot };
  if (snapshot.mixedLineEndings)
    return { files: [], error: `Mixed line endings are unsupported: ${target.relativePath}` };
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
      '',
    );
    if (!application.ok) return { files: [], error: failureMessage(application.failure) };
    content = application.content;
  }
  if (tooLarge(snapshot.text, content)) return { files: [], error: 'File is too large to preview' };
  return { files: [await diffFile(target.relativePath, 'update', snapshot.text, content, signal)] };
}

function multiEditSpecs(args: Record<string, unknown>): EditSpec[] | string {
  const edits = args.edits;
  if (!Array.isArray(edits)) return 'No edits provided';
  const specs: EditSpec[] = [];
  for (const item of edits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Malformed edit entry';
    const spec = editSpec(item as Record<string, unknown>);
    if (!spec) return 'Malformed edit entry';
    specs.push(spec);
  }
  return specs;
}

async function previewPatch(
  args: Record<string, unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MutationPreview> {
  const parsed = parsePatch(args.patch);
  if ('version' in parsed) return { files: [], error: failureMessage(parsed) };
  const files: MutationPreviewFile[] = [];
  for (const operation of parsed.operations) {
    const target = resolveTarget(workspaceRoot, operation.path);
    if (typeof target === 'string') return { files: [], error: target };
    const before = await snapshotOf(target, operation.kind === 'add');
    if (typeof before === 'string') return { files: [], error: before };
    if (operation.kind === 'add') {
      if (before.exists) return { files: [], error: `File already exists: ${target.relativePath}` };
      const after = operation.lines.join('\n') + (operation.lines.length > 0 ? '\n' : '');
      if (tooLarge('', after)) return { files: [], error: 'File is too large to preview' };
      files.push(await diffFile(target.relativePath, 'create', '', after, signal));
      continue;
    }
    if (operation.kind === 'delete') {
      if (tooLarge(before.text, '')) return { files: [], error: 'File is too large to preview' };
      files.push(await diffFile(target.relativePath, 'delete', before.text, '', signal));
      continue;
    }
    if (before.mixedLineEndings)
      return {
        files: [],
        error: `Mixed line endings are unsupported for patch updates: ${target.relativePath}`,
      };
    const applied = applyHunks(before.text, operation.hunks);
    if (applied.mismatch)
      return { files: [], error: `${target.relativePath}: ${failureMessage(applied.mismatch)}` };
    if (tooLarge(before.text, applied.text))
      return { files: [], error: 'File is too large to preview' };
    files.push(await diffFile(target.relativePath, 'update', before.text, applied.text, signal));
  }
  return { files };
}

/**
 * Compute the diff a pending mutation would produce, or `null` when the tool
 * is not one this module understands. Never throws for a bad call: every
 * failure the tool would report comes back as {@link MutationPreview.error}.
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
      case 'Edit': {
        const spec = editSpec(args);
        if (!spec) return { files: [], error: 'No edit given' };
        return await previewEdits(args, [spec], false, workspaceRoot, signal);
      }
      case 'MultiEdit': {
        const specs = multiEditSpecs(args);
        if (typeof specs === 'string') return { files: [], error: specs };
        return await previewEdits(args, specs, true, workspaceRoot, signal);
      }
      case 'ApplyPatch':
        return await previewPatch(args, workspaceRoot, signal);
      default:
        return null;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      files: [],
      error: `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
