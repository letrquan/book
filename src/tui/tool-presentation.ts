import type { ToolResult } from '../types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import { formatByteSize } from './components/tool-output.js';

export type TranscriptMode = 'compact' | 'detailed';
export type TranscriptShortcutAction = 'enter-detailed' | 'exit-detailed' | 'expand-output';
export type ToolPresentationStatus = 'running' | 'pending' | 'success' | 'failure' | 'skipped';
export type ToolPreviewType = 'none' | 'text' | 'markdown' | 'diff';

export interface ToolPresentation {
  canonicalName: string;
  status: ToolPresentationStatus;
  title: string;
  target?: string;
  metadata: string[];
  summary: string;
  previewType: ToolPreviewType;
  showArguments: boolean;
  hasDetails: boolean;
  hasHiddenContent: boolean;
  filePath?: string;
}

export interface ToolPresentationOptions {
  isPending?: boolean;
  nestedActivityCount?: number;
}

export function getTranscriptShortcutAction(
  mode: TranscriptMode,
  input: string,
  key: { ctrl?: boolean; meta?: boolean; escape?: boolean },
): TranscriptShortcutAction | null {
  if (
    mode === 'detailed' &&
    (key.escape || (!key.ctrl && !key.meta && input.toLowerCase() === 'q'))
  ) {
    return 'exit-detailed';
  }
  if (key.ctrl && (input === 'o' || input.charCodeAt(0) === 15)) {
    return mode === 'detailed' ? 'exit-detailed' : 'enter-detailed';
  }
  if (key.ctrl && (input === 'e' || input.charCodeAt(0) === 5)) return 'expand-output';
  return null;
}

export interface PresentableToolInvocation<TCall = unknown> {
  id: string;
  name: string;
  call: TCall;
  result?: ToolResult;
}

export type CompactToolGroup<TCall = unknown> =
  | { kind: 'tool'; invocation: PresentableToolInvocation<TCall> }
  | {
      kind: 'mcp-group';
      id: string;
      server: string;
      invocations: PresentableToolInvocation<TCall>[];
    };

/** Group adjacent successful, completed MCP calls from the same server. */
export function groupConsecutiveMcpCalls<TCall>(
  invocations: readonly PresentableToolInvocation<TCall>[],
): CompactToolGroup<TCall>[] {
  const groups: CompactToolGroup<TCall>[] = [];
  for (let index = 0; index < invocations.length;) {
    const current = invocations[index];
    const mcp = parseMcpToolName(current.name);
    if (!mcp || !current.result?.success) {
      groups.push({ kind: 'tool', invocation: current });
      index++;
      continue;
    }

    const consecutive: PresentableToolInvocation<TCall>[] = [current];
    let nextIndex = index + 1;
    while (nextIndex < invocations.length) {
      const next = invocations[nextIndex];
      const nextMcp = parseMcpToolName(next.name);
      if (!nextMcp || nextMcp.server !== mcp.server || !next.result?.success) break;
      consecutive.push(next);
      nextIndex++;
    }

    if (consecutive.length === 1) groups.push({ kind: 'tool', invocation: current });
    else {
      groups.push({
        kind: 'mcp-group',
        id: `mcp-group:${consecutive.map((item) => item.id).join(',')}`,
        server: mcp.server,
        invocations: consecutive,
      });
    }
    index = nextIndex;
  }
  return groups;
}

const LABELS: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit notebook',
  Bash: 'Bash',
  BashOutput: 'Shell output',
  KillShell: 'Kill shell',
  Glob: 'Glob',
  Grep: 'Grep',
  WebFetch: 'Fetch',
  WebSearch: 'Search web',
  GitStatus: 'Git status',
  GitDiff: 'Git diff',
  GitLog: 'Git log',
  GitCommit: 'Git commit',
  GitBranch: 'Git branch',
  TodoWrite: 'Update todos',
  Task: 'Task',
  InvokeSkill: 'Skill',
};

export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!match) return undefined;
  return { server: match[1], tool: match[2].replace(/_/g, ' ') };
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function countOutputLines(output: string | undefined): number {
  if (!output) return 0;
  return output.split('\n').length;
}

function countNonEmptyOutputLines(output: string | undefined): number {
  if (!output) return 0;
  return output.split('\n').filter((line) => line.trim().length > 0).length;
}

function outputSizeMetadata(result: ToolResult | undefined): string | undefined {
  if (!result?.output) return undefined;
  const bytes = Buffer.byteLength(result.output, 'utf8');
  const lines = countOutputLines(result.output);
  return `${lines} ${lines === 1 ? 'line' : 'lines'}, ${formatByteSize(bytes)}`;
}

function statusFor(result: ToolResult | undefined, isPending: boolean): ToolPresentationStatus {
  if (isPending) return 'pending';
  if (!result) return 'running';
  if (result.error?.startsWith('SKIPPED')) return 'skipped';
  return result.success ? 'success' : 'failure';
}

function resultStatusMetadata(status: ToolPresentationStatus): string | undefined {
  if (status === 'failure') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'pending') return 'needs approval';
  return undefined;
}

function fileMutationPresentation(
  canonicalName: string,
  args: Record<string, unknown>,
  result: ToolResult | undefined,
  status: ToolPresentationStatus,
): Pick<ToolPresentation, 'title' | 'target' | 'metadata' | 'previewType' | 'filePath'> {
  const filePath =
    result?.fileMutation?.filePath ??
    stringArg(args, 'filePath', 'file_path', 'notebook_path', 'path') ??
    getPrimaryArg(args);
  const action = result?.fileMutation?.kind === 'create' || result?.isCreate ? 'Create' : 'Update';
  const metadata: string[] = [];
  const mutation =
    result?.fileMutation ??
    (result?.success && /^@@/m.test(result.output)
      ? {
          kind: result.isCreate ? ('create' as const) : ('update' as const),
          filePath,
          addedLines: result.output
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          removedLines: result.output
            .split('\n')
            .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
        }
      : undefined);
  if (result?.success && mutation) {
    if (mutation.addedLines > 0) metadata.push(`+${mutation.addedLines}`);
    if (mutation.removedLines > 0) metadata.push(`-${mutation.removedLines}`);
    if (mutation.addedLines === 0 && mutation.removedLines === 0) metadata.push('no changes');
  } else {
    const statusLabel = resultStatusMetadata(status);
    if (statusLabel) metadata.push(statusLabel);
  }
  const previewType = result?.success && /^@@/m.test(result.output) ? 'diff' : 'none';
  return {
    title: action,
    target: filePath,
    metadata,
    previewType,
    filePath,
  };
}

function readMetadata(args: Record<string, unknown>, result: ToolResult | undefined): string[] {
  if (!result?.success) return [];
  const lineCount = countOutputLines(result.output);
  const offset = Number(args.offset ?? 0);
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
  const end = Math.max(start, start + Math.max(0, lineCount - 1));
  if (lineCount === 0) return ['empty'];
  return [lineCount === 1 ? '1 line' : `${lineCount} lines`, `${start}-${end}`];
}

function domainFor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

/** Derive all concise tool-row text without depending on Ink rendering. */
export function deriveToolPresentation(
  name: string,
  args: Record<string, unknown>,
  result?: ToolResult,
  options: ToolPresentationOptions = {},
): ToolPresentation {
  const canonicalName = canonicalToolName(name);
  const status = statusFor(result, Boolean(options.isPending));
  const primary = getPrimaryArg(args);
  const mcp = parseMcpToolName(name);
  let title = LABELS[canonicalName] ?? canonicalName;
  let target = primary || undefined;
  let metadata: string[] = [];
  let previewType: ToolPreviewType = result?.output ? 'text' : 'none';
  const showArguments = !isFileMutatingTool(canonicalName);
  let filePath: string | undefined;

  if (isFileMutatingTool(canonicalName)) {
    const mutation = fileMutationPresentation(canonicalName, args, result, status);
    title = mutation.title;
    target = mutation.target;
    metadata = mutation.metadata;
    previewType = mutation.previewType;
    filePath = mutation.filePath;
  } else if (canonicalName === 'Read') {
    target = stringArg(args, 'filePath', 'file_path', 'path') ?? target;
    metadata = readMetadata(args, result);
  } else if (canonicalName === 'Glob') {
    target = stringArg(args, 'pattern') ?? target;
    if (result?.success) {
      const files = /^(?:No files found|No matches found)$/i.test(result.output.trim())
        ? 0
        : countNonEmptyOutputLines(result.output.replace(/\n\.\.\. \(truncated[\s\S]*$/, ''));
      metadata = [`${files} ${files === 1 ? 'file' : 'files'}`];
    }
  } else if (canonicalName === 'Grep') {
    target = stringArg(args, 'pattern') ?? target;
    if (result?.success) {
      const outputMode = stringArg(args, 'output_mode') ?? 'content';
      if (/^No matches found$/i.test(result.output.trim())) metadata = ['0 matches'];
      else if (outputMode === 'files_with_matches') {
        const files = countNonEmptyOutputLines(result.output);
        metadata = [`${files} ${files === 1 ? 'file' : 'files'}`];
      } else if (outputMode === 'count') {
        const matches = result.output.split('\n').reduce((total, line) => {
          const count = /:(\d+)\s*$/.exec(line)?.[1];
          return total + (count ? Number(count) : 0);
        }, 0);
        metadata = [`${matches} ${matches === 1 ? 'match' : 'matches'}`];
      } else {
        const contentLines = result.output.split('\n');
        const structuredMatches = contentLines.filter((line) => /:\d+:/.test(line)).length;
        const matches = structuredMatches || contentLines.filter((line) => line.trim()).length;
        metadata = [`${matches} ${matches === 1 ? 'match' : 'matches'}`];
      }
    }
  } else if (canonicalName === 'WebFetch') {
    target = domainFor(stringArg(args, 'url'));
    previewType = result?.output ? 'markdown' : 'none';
  } else if (canonicalName === 'WebSearch') {
    target = stringArg(args, 'query') ?? target;
    previewType = result?.output ? 'markdown' : 'none';
  } else if (canonicalName === 'Task') {
    target = stringArg(args, 'agent', 'subject', 'description', 'prompt') ?? target;
    if ((options.nestedActivityCount ?? 0) > 0) {
      const count = options.nestedActivityCount ?? 0;
      metadata.push(`${count} ${count === 1 ? 'activity' : 'activities'}`);
    }
  } else if (mcp) {
    const groupCount = Number(args.__groupCount ?? 0);
    title =
      Number.isSafeInteger(groupCount) && groupCount > 1
        ? `Called ${mcp.server} ${groupCount} times`
        : `Called ${mcp.server}`;
    target = groupCount > 1 ? undefined : mcp.tool;
    previewType = result?.output ? 'markdown' : 'none';
  } else if (
    canonicalName === 'Bash' ||
    canonicalName.startsWith('Git') ||
    canonicalName === 'BashOutput'
  ) {
    const size = outputSizeMetadata(result);
    if (size) metadata.push(size);
  }

  const statusMetadata = resultStatusMetadata(status);
  if (statusMetadata && !metadata.includes(statusMetadata)) metadata.unshift(statusMetadata);
  const duration = formatDuration(result?.durationMs);
  if (duration) metadata.push(duration);
  if (result?.retryAttempt && result.retryAttempt > 1)
    metadata.push(`attempt ${result.retryAttempt}`);

  const targetText = target ? `(${target})` : '';
  const metadataText = metadata.length > 0 ? ` · ${metadata.join(' ')}` : '';
  const summary = `${title}${targetText}${metadataText}`;
  const hasDetails = (showArguments && Object.keys(args).length > 0) || Boolean(result?.output);

  return {
    canonicalName,
    status,
    title,
    target,
    metadata,
    summary,
    previewType,
    showArguments,
    hasDetails,
    hasHiddenContent: hasDetails,
    filePath,
  };
}

export interface ToolExpansionPolicyInput {
  mode: TranscriptMode;
  toolId: string;
  automaticToolId?: string | null;
  expansionOverrides: ReadonlyMap<string, boolean>;
  screenReader?: boolean;
}

/** Centralized expansion policy shared by top-level and nested tool rows. */
export function shouldExpandTool({
  mode,
  toolId,
  automaticToolId,
  expansionOverrides,
  screenReader = false,
}: ToolExpansionPolicyInput): boolean {
  if (screenReader) return true;
  const override = expansionOverrides.get(toolId);
  if (override !== undefined) return override;
  return mode === 'detailed' || automaticToolId === toolId;
}
