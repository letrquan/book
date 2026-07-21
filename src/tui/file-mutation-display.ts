import type { ToolResult } from '../types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import { isUnifiedDiffLike } from './components/Diff.js';

export function isRenderableFileMutationDiff(
  toolName: string,
  result: ToolResult | undefined,
): boolean {
  if (result?.status !== 'success' || !result.content) return false;
  return isFileMutatingTool(canonicalToolName(toolName)) && isUnifiedDiffLike(result.content);
}
