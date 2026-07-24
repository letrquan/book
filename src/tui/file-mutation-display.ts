import type { ToolResult } from '../types/tools.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import { isUnifiedDiffLike } from './components/Diff.js';

export interface FileMutationDisplaySummary {
  filePath: string;
  kind: 'create' | 'update' | 'delete';
  addedLines: number;
  removedLines: number;
  fileCount?: number;
}

export function isRenderableFileMutationDiff(
  toolName: string,
  result: ToolResult | undefined,
): boolean {
  if (result?.status !== 'success' || !result.content) return false;
  return isFileMutatingTool(canonicalToolName(toolName)) && isUnifiedDiffLike(result.content);
}

export function getFileMutationDisplaySummary(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult | undefined,
): FileMutationDisplaySummary | undefined {
  if (!isRenderableFileMutationDiff(toolName, result)) return undefined;

  const mutations = result?.artifacts?.fileMutations ?? [];
  if (mutations.length > 1) {
    const kinds = new Set(mutations.map((mutation) => mutation.kind));
    return {
      filePath: `${mutations.length} files`,
      kind: kinds.size === 1 ? mutations[0].kind : 'update',
      addedLines: mutations.reduce((total, mutation) => total + mutation.addedLines, 0),
      removedLines: mutations.reduce((total, mutation) => total + mutation.removedLines, 0),
      fileCount: new Set(mutations.map((mutation) => mutation.filePath)).size,
    };
  }
  const mutation = result?.artifacts?.fileMutation;
  const filePath =
    mutation?.filePath ??
    ['filePath', 'file_path', 'notebook_path', 'path']
      .map((key) => args[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0) ??
    getPrimaryArg(args) ??
    '(unknown file)';
  const lines = result?.content.split('\n') ?? [];
  const addedLines =
    mutation?.addedLines ??
    lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removedLines =
    mutation?.removedLines ??
    lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;

  return {
    filePath,
    kind: mutation?.kind ?? 'update',
    addedLines,
    removedLines,
    fileCount: 1,
  };
}
