import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  FileMutationSummary,
} from '../types/tools.js';
import { throwIfAborted } from '../async.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { observeFile, requireFreshObservation } from './file-provenance.js';
import { pathOutsideWorkspaceResult, resolveWorkspacePath } from './path-utils.js';
import { toolFailure, toolSuccess } from './result.js';
import {
  readTextSnapshot,
  removeFileAtomically,
  restoreTextEncoding,
  withMutationLocks,
  writeFileAtomically,
  type TextSnapshot,
} from './mutation.js';

const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_FILES = 100;
const MAX_HUNKS = 1000;

export type PatchOperation =
  | { kind: 'update'; path: string; hunks: PatchHunk[] }
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string };

interface PatchHunk {
  header: string;
  oldStart?: number;
  lines: Array<{
    kind: 'context' | 'remove' | 'add';
    text: string;
    noNewline?: boolean;
  }>;
}

interface StagedFile {
  operation: PatchOperation;
  absolutePath: string;
  writePath: string;
  relativePath: string;
  before: TextSnapshot;
  afterBytes?: Buffer;
  afterText?: string;
  mutation: FileMutationSummary;
}

export interface ParsedPatch {
  operations: PatchOperation[];
  bytes: number;
}

function invalid(message: string, details?: Record<string, unknown>): ToolResult {
  return toolFailure(message, {
    code: 'invalid_patch_syntax',
    remediation: 'Regenerate a Codex-style patch with Begin/End markers and valid file hunks.',
    details,
  });
}

function parseHunkHeader(line: string): { oldStart?: number } {
  const match = line.match(/^@@(?: -(\d+)(?:,(\d+))?)?(?: \+(\d+)(?:,(\d+))?)?(?: @@.*)?$/);
  if (!match) throw new Error(`Invalid hunk header: ${line}`);
  return { oldStart: match[1] ? Number(match[1]) : undefined };
}

function parsePatchUnsafe(patch: unknown): ParsedPatch | ToolResult {
  if (typeof patch !== 'string' || patch.length === 0)
    return invalid('patch must be a non-empty string');
  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes > MAX_PATCH_BYTES)
    return toolFailure(`Patch input exceeds ${MAX_PATCH_BYTES} bytes`, {
      code: 'patch_limit_exceeded',
      remediation: 'Split the change into smaller patches.',
      details: { limit: MAX_PATCH_BYTES, bytes },
    });
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch')
    return invalid('Patch must start with *** Begin Patch and end with *** End Patch');

  const operations: PatchOperation[] = [];
  let index = 1;
  let hunkCount = 0;
  while (index < lines.length - 1) {
    const marker = lines[index];
    const update = marker.match(/^\*\*\* Update File: (.+)$/);
    const add = marker.match(/^\*\*\* Add File: (.+)$/);
    const del = marker.match(/^\*\*\* Delete File: (.+)$/);
    if (update) {
      const hunks: PatchHunk[] = [];
      index++;
      while (index < lines.length - 1 && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('@@'))
          throw new Error(`Expected @@ hunk header near line ${index + 1}`);
        const header = lines[index];
        const parsedHeader = parseHunkHeader(header);
        index++;
        const hunkLines: PatchHunk['lines'] = [];
        while (
          index < lines.length - 1 &&
          !lines[index].startsWith('@@') &&
          !lines[index].startsWith('*** ')
        ) {
          const line = lines[index++];
          if (line === '\\ No newline at end of file') {
            const previous = hunkLines.at(-1);
            if (!previous)
              throw new Error(`No-newline marker has no preceding hunk line near line ${index}`);
            previous.noNewline = true;
            continue;
          }
          if (line.startsWith(' ')) hunkLines.push({ kind: 'context', text: line.slice(1) });
          else if (line.startsWith('-')) hunkLines.push({ kind: 'remove', text: line.slice(1) });
          else if (line.startsWith('+')) hunkLines.push({ kind: 'add', text: line.slice(1) });
          else throw new Error(`Invalid hunk line near line ${index}`);
        }
        if (hunkLines.length === 0) throw new Error(`Empty hunk near line ${index}`);
        if (!hunkLines.some((line) => line.kind !== 'add'))
          throw new Error(`Update hunk must contain context or removed lines near line ${index}`);
        hunks.push({ header, oldStart: parsedHeader.oldStart, lines: hunkLines });
        hunkCount++;
      }
      if (hunks.length === 0) throw new Error(`Update File ${update[1]} has no hunks`);
      operations.push({ kind: 'update', path: update[1].trim(), hunks });
      continue;
    }
    if (add) {
      index++;
      const content: string[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith('*** ')) {
        const line = lines[index++];
        if (!line.startsWith('+'))
          throw new Error(`Added file lines must begin with + near line ${index}`);
        content.push(line.slice(1));
      }
      operations.push({ kind: 'add', path: add[1].trim(), lines: content });
      continue;
    }
    if (del) {
      index++;
      if (index < lines.length - 1 && !lines[index].startsWith('*** '))
        throw new Error(`Delete File ${del[1]} cannot contain patch lines`);
      operations.push({ kind: 'delete', path: del[1].trim() });
      continue;
    }
    throw new Error(`Expected a file operation near line ${index + 1}`);
  }
  if (operations.length === 0) return invalid('Patch contains no file operations');
  if (operations.length > MAX_FILES || hunkCount > MAX_HUNKS)
    return toolFailure(`Patch exceeds limits (${MAX_FILES} files, ${MAX_HUNKS} hunks)`, {
      code: 'patch_limit_exceeded',
      remediation: 'Split the change into smaller patches.',
      details: { files: operations.length, hunks: hunkCount },
    });
  return { operations, bytes };
}

export function parsePatch(patch: unknown): ParsedPatch | ToolResult {
  try {
    return parsePatchUnsafe(patch);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function findUniqueSequence(
  haystack: string[],
  needle: string[],
): { index: number; count: number } {
  if (needle.length === 0) return { index: 0, count: 0 };
  let index = -1;
  let count = 0;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) {
      index = start;
      count++;
    }
  }
  return { index, count };
}

function candidateLine(haystack: string[], line: string): number | undefined {
  const matches = haystack.reduce<number[]>((found, value, index) => {
    if (value === line) found.push(index + 1);
    return found;
  }, []);
  return matches.length === 1 ? matches[0] : undefined;
}

function applyHunks(text: string, hunks: PatchHunk[]): { text: string; mismatch?: ToolResult } {
  let lines = linesOf(text);
  let trailingNewline = text.endsWith('\n');
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    const oldLines = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== 'remove').map((line) => line.text);
    const match = findUniqueSequence(lines, oldLines);
    if (match.count === 0)
      return {
        text,
        mismatch: toolFailure(`Hunk ${hunkIndex + 1}: patch context not found`, {
          code: 'patch_context_not_found',
          remediation:
            'Reread the affected range and regenerate the hunk against the latest file contents.',
          details: {
            hunkIndex: hunkIndex + 1,
            header: hunk.header,
            firstContextLine: oldLines[0]?.slice(0, 200),
            closestCandidateLine: oldLines[0] ? candidateLine(lines, oldLines[0]) : undefined,
            suggestedReadRange:
              hunk.oldStart !== undefined
                ? {
                    lineStart: Math.max(1, hunk.oldStart - 3),
                    lineEnd: hunk.oldStart + oldLines.length + 3,
                  }
                : undefined,
          },
        }),
      };
    if (match.count > 1)
      return {
        text,
        mismatch: toolFailure(`Hunk ${hunkIndex + 1}: patch context is ambiguous`, {
          code: 'ambiguous_patch_context',
          remediation: 'Reread a narrower range and include more exact context lines.',
          details: { hunkIndex: hunkIndex + 1, header: hunk.header, matches: match.count },
        }),
      };
    const touchesEndOfFile = match.index + oldLines.length === lines.length;
    lines = [
      ...lines.slice(0, match.index),
      ...newLines,
      ...lines.slice(match.index + oldLines.length),
    ];
    if (touchesEndOfFile) {
      const oldNoNewline = hunk.lines.some((line) => line.kind !== 'add' && line.noNewline);
      const newNoNewline = hunk.lines.some((line) => line.kind !== 'remove' && line.noNewline);
      if (newNoNewline) trailingNewline = false;
      else if (oldNoNewline) trailingNewline = true;
    }
  }
  return { text: lines.join('\n') + (trailingNewline && lines.length > 0 ? '\n' : '') };
}

function mutationFromDiff(
  relativePath: string,
  kind: FileMutationSummary['kind'],
  stats: { addedLines: number; removedLines: number },
): FileMutationSummary {
  return {
    kind,
    filePath: relativePath,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
  };
}

function errorCodeFor(error: unknown): string {
  return error instanceof Error && error.message.includes('changed or disappeared')
    ? 'stale_file_observation'
    : 'filesystem_error';
}

async function applyPatch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parsePatch(args.patch);
  if (!('operations' in parsed)) return parsed;
  const paths = parsed.operations.map((operation) => operation.path);
  const resolved = parsed.operations.map((operation) => {
    const result = resolveWorkspacePath(ctx.workspaceRoot, operation.path);
    return result ? { operation, ...result } : null;
  });
  if (resolved.some((entry) => !entry))
    return pathOutsideWorkspaceResult(paths[resolved.findIndex((entry) => !entry)]);
  const entries = resolved as Array<{
    operation: PatchOperation;
    filePath: string;
    canonicalPath: string;
    relativePath: string;
  }>;
  const canonicalKeys = entries.map((entry) =>
    process.platform === 'win32' ? entry.canonicalPath.toLowerCase() : entry.canonicalPath,
  );
  if (new Set(canonicalKeys).size !== canonicalKeys.length)
    return toolFailure('A patch may contain only one operation per file', {
      code: 'patch_conflict',
      remediation: 'Combine related updates into one file operation with multiple hunks.',
    });

  return withMutationLocks(
    entries.map((entry) => entry.canonicalPath),
    async () => {
      const staged: StagedFile[] = [];
      try {
        for (const entry of entries) {
          throwIfAborted(ctx.signal);
          const before = await readTextSnapshot(entry.filePath, entry.operation.kind === 'add');
          if (before.binary)
            return toolFailure(`Binary file is unsupported: ${entry.relativePath}`, {
              code: 'binary_file_unsupported',
              remediation: 'Use a text file mutation or a dedicated binary workflow.',
            });
          if (before.mixedLineEndings && entry.operation.kind === 'update')
            return toolFailure(
              `Mixed line endings are unsupported for patch updates: ${entry.relativePath}`,
              {
                code: 'patch_conflict',
                remediation:
                  'Normalize the file line endings, reread it, and regenerate the patch.',
                details: { filePath: entry.relativePath, lineEnding: 'mixed' },
              },
            );
          const stale =
            entry.operation.kind === 'add'
              ? undefined
              : await requireFreshObservation(ctx, entry.filePath, entry.relativePath);
          if (stale)
            return toolFailure(stale, {
              code: 'stale_file_observation',
              remediation: 'Call Read before regenerating the patch.',
            });
          if (entry.operation.kind === 'add') {
            if (before.exists)
              return toolFailure(`File already exists: ${entry.relativePath}`, {
                code: 'patch_conflict',
                remediation: 'Use Update File for an existing file.',
              });
            const afterText =
              entry.operation.lines.join('\n') + (entry.operation.lines.length > 0 ? '\n' : '');
            const { stats } = await renderDiffWithStatsAsync('', afterText, 3, ctx.signal);
            staged.push({
              operation: entry.operation,
              absolutePath: entry.filePath,
              writePath: entry.canonicalPath,
              relativePath: entry.relativePath,
              before,
              afterText,
              afterBytes: Buffer.from(afterText, 'utf8'),
              mutation: mutationFromDiff(entry.relativePath, 'create', stats),
            });
          } else if (entry.operation.kind === 'delete') {
            if (!before.exists)
              return toolFailure(`File not found: ${entry.relativePath}`, {
                code: 'patch_conflict',
                remediation: 'Reread the workspace and regenerate the patch.',
              });
            staged.push({
              operation: entry.operation,
              absolutePath: entry.filePath,
              writePath: entry.filePath,
              relativePath: entry.relativePath,
              before,
              mutation: {
                kind: 'delete',
                filePath: entry.relativePath,
                addedLines: 0,
                removedLines: linesOf(before.text).length,
              },
            });
          } else {
            if (!before.exists)
              return toolFailure(`File not found: ${entry.relativePath}`, {
                code: 'patch_context_not_found',
                remediation: 'Reread the file and regenerate the patch.',
              });
            const applied = applyHunks(before.text, entry.operation.hunks);
            if (applied.mismatch)
              return toolFailure(
                `${entry.relativePath}: ${applied.mismatch.structuredError?.message}`,
                {
                  ...applied.mismatch.structuredError,
                  code: applied.mismatch.structuredError?.code ?? 'patch_context_not_found',
                  remediation: applied.mismatch.structuredError?.remediation,
                  details: {
                    ...applied.mismatch.structuredError?.details,
                    filePath: entry.relativePath,
                    lineEnding: before.mixedLineEndings ? 'mixed' : before.lineEnding,
                    normalizedMatching: true,
                  },
                },
              );
            const afterText = applied.text;
            const { stats } = await renderDiffWithStatsAsync(before.text, afterText, 3, ctx.signal);
            staged.push({
              operation: entry.operation,
              absolutePath: entry.filePath,
              writePath: entry.canonicalPath,
              relativePath: entry.relativePath,
              before,
              afterText,
              afterBytes: restoreTextEncoding(afterText, before),
              mutation: mutationFromDiff(entry.relativePath, 'update', stats),
            });
          }
        }

        const mutations = staged.map((file) => file.mutation);
        const changedLines = mutations.reduce(
          (total, mutation) => total + mutation.addedLines + mutation.removedLines,
          0,
        );
        const contextLines = parsed.operations.reduce(
          (total, operation) =>
            total +
            (operation.kind === 'update'
              ? operation.hunks.reduce(
                  (hunkTotal, hunk) =>
                    hunkTotal + hunk.lines.filter((line) => line.kind === 'context').length,
                  0,
                )
              : 0),
          0,
        );
        const changeBudgetWarnings: string[] = [];
        if (changedLines > 2_000) changeBudgetWarnings.push('large_change');
        if (changedLines > 100 && changedLines > Math.max(1, contextLines) * 20)
          changeBudgetWarnings.push('low_context_to_change_ratio');

        const diffs: string[] = [];
        for (const file of staged) {
          throwIfAborted(ctx.signal);
          const afterText = file.afterText ?? '';
          const { diff } = await renderDiffWithStatsAsync(
            file.before.text,
            afterText,
            3,
            ctx.signal,
          );
          if (diff) diffs.push(`--- ${file.relativePath}\n+++ ${file.relativePath}\n${diff}`);
        }
        const committed: StagedFile[] = [];
        try {
          for (const file of staged) {
            throwIfAborted(ctx.signal);
            committed.push(file);
            if (file.operation.kind === 'delete')
              await removeFileAtomically(file.absolutePath, ctx.signal);
            else
              await writeFileAtomically(
                file.writePath,
                file.afterBytes!,
                ctx.signal,
                file.before.mode,
              );
            const check = await readTextSnapshot(
              file.absolutePath,
              file.operation.kind === 'delete',
            );
            if (
              file.operation.kind === 'delete'
                ? check.exists
                : !check.exists || !check.bytes.equals(file.afterBytes!)
            )
              throw new Error(`Post-write verification failed for ${file.relativePath}`);
          }
        } catch (error) {
          let rollbackFailed = false;
          for (const file of committed.reverse()) {
            try {
              if (file.before.exists)
                await writeFileAtomically(
                  file.writePath,
                  file.before.bytes,
                  undefined,
                  file.before.mode,
                );
              else await removeFileAtomically(file.absolutePath).catch(() => undefined);
            } catch {
              rollbackFailed = true;
            }
          }
          return toolFailure(
            `Patch commit failed${rollbackFailed ? '; rollback also failed' : ' and was rolled back'}: ${error instanceof Error ? error.message : String(error)}`,
            {
              code: rollbackFailed ? 'patch_rollback_failed' : 'filesystem_error',
              remediation: rollbackFailed
                ? 'Inspect the affected files and restore them manually.'
                : 'Retry after checking the workspace state.',
            },
          );
        }

        const observations = [];
        for (const file of staged) {
          if (file.operation.kind !== 'delete')
            observations.push(
              await observeFile(
                ctx,
                file.absolutePath,
                file.operation.kind === 'add' ? 'create' : 'edit',
              ),
            );
        }
        const result = toolSuccess(
          diffs.join('\n') || 'Patch applied successfully (no textual change)',
          {
            data: {
              files: mutations.map((mutation) => mutation.filePath),
              changedFiles: mutations.length,
              changedLines,
              patchBytes: parsed.bytes,
              changeBudgetWarnings,
            },
            artifacts: {
              fileMutation: mutations[0],
              fileMutations: mutations,
              fileObservations: observations,
            },
            presentation: {
              kind: 'diff',
              summary: `Applied patch to ${mutations.length} ${mutations.length === 1 ? 'file' : 'files'}`,
              target: mutations.length === 1 ? mutations[0].filePath : `${mutations.length} files`,
            },
          },
        );
        return result;
      } catch (error) {
        const code = errorCodeFor(error);
        return toolFailure(error instanceof Error ? error.message : String(error), {
          code,
          remediation: 'Reread the affected file and regenerate the patch.',
        });
      }
    },
  );
}

export const patchTools: ToolDefinition[] = [
  {
    name: 'ApplyPatch',
    argumentAliases: { input: 'patch' },
    description:
      'Apply a Codex-style patch with Update File, Add File, or Delete File operations across one or more files atomically. Read the targets first; use exact contextual hunks, and regenerate the patch after a context mismatch instead of resending it unchanged.',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PATCH_BYTES,
          description: 'Patch text beginning with *** Begin Patch and ending with *** End Patch',
        },
        baseObservation: {
          type: 'string',
          maxLength: 128,
          description:
            'Optional short observation identifier for diagnostics; freshness is checked implicitly.',
        },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    execute: applyPatch,
  },
];
