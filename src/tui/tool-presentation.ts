import type { ToolResult } from '../types/tools.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import { formatByteSize } from './components/tool-output.js';
import { displayWidth, truncateDisplay } from './components/word-wrap.js';
import { MIN_TARGET_WIDTH, type TranscriptGrid } from './layout.js';
import { isRenderableFileMutationDiff } from './file-mutation-display.js';

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
    if (!mcp || current.result?.status !== 'success') {
      groups.push({ kind: 'tool', invocation: current });
      index++;
      continue;
    }

    const consecutive: PresentableToolInvocation<TCall>[] = [current];
    let nextIndex = index + 1;
    while (nextIndex < invocations.length) {
      const next = invocations[nextIndex];
      const nextMcp = parseMcpToolName(next.name);
      if (!nextMcp || nextMcp.server !== mcp.server || next.result?.status !== 'success') break;
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
  ApplyPatch: 'Apply patch',
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
  if (!result?.content) return undefined;
  const bytes = Buffer.byteLength(result.content, 'utf8');
  const lines = countOutputLines(result.content);
  return `${lines} ${lines === 1 ? 'line' : 'lines'}, ${formatByteSize(bytes)}`;
}

function statusFor(result: ToolResult | undefined, isPending: boolean): ToolPresentationStatus {
  if (isPending) return 'pending';
  if (!result) return 'running';
  if (result.status === 'blocked') return 'skipped';
  return result.status === 'success' ? 'success' : 'failure';
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
    result?.artifacts?.fileMutation?.filePath ??
    stringArg(args, 'filePath', 'file_path', 'notebook_path', 'path') ??
    getPrimaryArg(args);
  const action =
    result?.artifacts?.fileMutation?.kind === 'create'
      ? 'Create'
      : result?.artifacts?.fileMutation?.kind === 'delete'
        ? 'Delete'
        : 'Update';
  const metadata: string[] = [];
  const mutation =
    result?.artifacts?.fileMutation ??
    (result?.status === 'success' && /^@@/m.test(result.content)
      ? {
          kind: 'update' as const,
          filePath,
          addedLines: result.content
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          removedLines: result.content
            .split('\n')
            .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
        }
      : undefined);
  if (result?.status === 'success' && mutation) {
    if (mutation.addedLines > 0) metadata.push(`+${mutation.addedLines}`);
    if (mutation.removedLines > 0) metadata.push(`-${mutation.removedLines}`);
    if (mutation.addedLines === 0 && mutation.removedLines === 0) metadata.push('no changes');
  } else {
    const statusLabel = resultStatusMetadata(status);
    if (statusLabel) metadata.push(statusLabel);
  }
  const previewType = result?.status === 'success' && /^@@/m.test(result.content) ? 'diff' : 'none';
  return {
    title: action,
    target: filePath,
    metadata,
    previewType,
    filePath,
  };
}

function readMetadata(args: Record<string, unknown>, result: ToolResult | undefined): string[] {
  if (result?.status !== 'success') return [];
  const lineCount = countOutputLines(result.content);
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
  let previewType: ToolPreviewType = result?.content ? 'text' : 'none';
  let filePath: string | undefined;

  if (result?.version === 2 && result.presentation) {
    const structured = result.presentation;
    target = structured.target ?? target;
    metadata = [...(structured.metadata ?? [])];
    previewType =
      structured.kind === 'diff'
        ? 'diff'
        : structured.kind === 'markdown' || structured.kind === 'search'
          ? 'markdown'
          : structured.details
            ? 'text'
            : 'none';
    const mutation = result.artifacts?.fileMutation;
    if (mutation) {
      title =
        mutation.kind === 'create' ? 'Create' : mutation.kind === 'delete' ? 'Delete' : 'Update';
      filePath = mutation.filePath;
      target = mutation.filePath;
    }
    const statusMetadata = resultStatusMetadata(status);
    if (statusMetadata && !metadata.includes(statusMetadata)) metadata.unshift(statusMetadata);
    const duration = formatDuration(result.metrics?.durationMs);
    if (duration) metadata.push(duration);
    const retryAttempt = result.metrics?.retryAttempt;
    if (retryAttempt && retryAttempt > 1) metadata.push(`attempt ${retryAttempt}`);
    const hasDetails = Boolean(structured.details);
    return {
      canonicalName,
      status,
      title,
      target,
      metadata,
      summary: structured.summary || `${title}${target ? `(${target})` : ''}`,
      previewType,
      hasDetails,
      hasHiddenContent: hasDetails,
      filePath,
    };
  }

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
    if (result?.status === 'success') {
      const files = /^(?:No files found|No matches found)$/i.test(result.content.trim())
        ? 0
        : countNonEmptyOutputLines(result.content.replace(/\n\.\.\. \(truncated[\s\S]*$/, ''));
      metadata = [`${files} ${files === 1 ? 'file' : 'files'}`];
    }
  } else if (canonicalName === 'Grep') {
    target = stringArg(args, 'pattern') ?? target;
    if (result?.status === 'success') {
      const outputMode = stringArg(args, 'output_mode') ?? 'content';
      if (/^No matches found$/i.test(result.content.trim())) metadata = ['0 matches'];
      else if (outputMode === 'files_with_matches') {
        const files = countNonEmptyOutputLines(result.content);
        metadata = [`${files} ${files === 1 ? 'file' : 'files'}`];
      } else if (outputMode === 'count') {
        const matches = result.content.split('\n').reduce((total, line) => {
          const count = /:(\d+)\s*$/.exec(line)?.[1];
          return total + (count ? Number(count) : 0);
        }, 0);
        metadata = [`${matches} ${matches === 1 ? 'match' : 'matches'}`];
      } else {
        const contentLines = result.content.split('\n');
        const structuredMatches = contentLines.filter((line) => /:\d+:/.test(line)).length;
        const matches = structuredMatches || contentLines.filter((line) => line.trim()).length;
        metadata = [`${matches} ${matches === 1 ? 'match' : 'matches'}`];
      }
    }
  } else if (canonicalName === 'WebFetch') {
    target = domainFor(stringArg(args, 'url'));
    previewType = result?.content ? 'markdown' : 'none';
  } else if (canonicalName === 'WebSearch') {
    target = stringArg(args, 'query') ?? target;
    previewType = result?.content ? 'markdown' : 'none';
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
    previewType = result?.content ? 'markdown' : 'none';
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
  const duration = formatDuration(result?.metrics?.durationMs);
  if (duration) metadata.push(duration);
  if (result?.metrics?.retryAttempt && result.metrics.retryAttempt > 1)
    metadata.push(`attempt ${result.metrics.retryAttempt}`);

  const targetText = target ? `(${target})` : '';
  const metadataText = metadata.length > 0 ? ` · ${metadata.join(' ')}` : '';
  const summary = `${title}${targetText}${metadataText}`;
  const hasDetails = Boolean(result?.content);

  return {
    canonicalName,
    status,
    title,
    target,
    metadata,
    summary,
    previewType,
    hasDetails,
    hasHiddenContent: hasDetails,
    filePath,
  };
}

export interface ToolExpansionPolicyInput {
  mode: TranscriptMode;
  toolId: string;
  automaticToolId?: string | null;
  defaultExpanded?: boolean;
  expansionOverrides: ReadonlyMap<string, boolean>;
  screenReader?: boolean;
}

/** Successful file mutations stay visible until the user explicitly collapses them. */
export function shouldDefaultExpandTool(name: string, result?: ToolResult): boolean {
  return isRenderableFileMutationDiff(name, result);
}

/** Centralized expansion policy shared by top-level and nested tool rows. */
export function shouldExpandTool({
  mode,
  toolId,
  automaticToolId,
  defaultExpanded = false,
  expansionOverrides,
  screenReader = false,
}: ToolExpansionPolicyInput): boolean {
  if (screenReader) return true;
  const override = expansionOverrides.get(toolId);
  if (override !== undefined) return override;
  return mode === 'detailed' || automaticToolId === toolId || defaultExpanded;
}

/**
 * Widest a failure message may grow the metadata column.
 *
 * Long enough for the shell errors that actually occur — `'tail' is not
 * recognized as an internal or external command` is 57 — without letting a
 * pathological message crowd out the target it failed on.
 */
const ERROR_META_MAX = 64;

/** MCP rows are titled `Called <server>` by {@link deriveToolPresentation}. */
const MCP_TITLE_PREFIX = 'Called ';

/** `+12` / `-3`: churn counts that belong together as one figure. */
const CHURN = /^[+-]\d+$/;

/**
 * Join metadata parts with `·`, except adjacent churn counts, which join with a
 * space so `+3 -2` reads as one number rather than two facts.
 */
function joinMetadata(parts: readonly string[]): string {
  return parts.reduce((joined, part, index) => {
    if (index === 0) return part;
    const separator = CHURN.test(part) && CHURN.test(parts[index - 1]!) ? ' ' : ' · ';
    return `${joined}${separator}${part}`;
  }, '');
}

/**
 * Shorten a presentation title for the aligned label column.
 *
 * An MCP row's title reads `Called <server>`; inside the column the verb is
 * redundant and the server name is what the reader scans for.
 */
export function shortLabel(title: string): string {
  const stripped = title.startsWith(MCP_TITLE_PREFIX)
    ? title.slice(MCP_TITLE_PREFIX.length)
    : title;
  return SHORT_LABELS[stripped] ?? stripped;
}

/**
 * The label a row will show, derived without scanning result content.
 *
 * Callers measuring a column across many rows must not pay for a full
 * {@link deriveToolPresentation} per row: that regex-scans result bodies, which
 * is real cost on a multi-megabyte tool result. This reads only the cheap
 * fields and is allowed to be wrong — an under-measured column costs one row
 * its alignment, never its content.
 */
export function toolRowLabel(name: string, result?: ToolResult): string {
  const mutation = result?.artifacts?.fileMutation;
  if (mutation) {
    return mutation.kind === 'create' ? 'Create' : mutation.kind === 'delete' ? 'Delete' : 'Update';
  }
  const mcp = parseMcpToolName(name);
  if (mcp) return mcp.server;
  const canonical = canonicalToolName(name);
  return shortLabel(LABELS[canonical] ?? canonical);
}

/** Widest label column a run of rows needs, in columns. */
export function toolLabelColumnWidth(labels: readonly string[]): number {
  return labels.reduce((widest, label) => Math.max(widest, displayWidth(label)), 1);
}

/** Labels short enough for the aligned row's fixed label column. */
const SHORT_LABELS: Record<string, string> = {
  'Apply patch': 'Patch',
  'Edit notebook': 'Notebook',
  'Shell output': 'Shell',
  'Update todos': 'Todos',
};

/** The three aligned columns of a tool row, already padded to the grid. */
export interface ToolRowColumns {
  /** Verb, padded to the grid's label column. Empty when labels are inline. */
  label: string;
  /** What the tool acted on, truncated to fit. */
  target: string;
  /** Spaces that push `meta` flush against the right edge. */
  gap: string;
  /** Right-aligned result metadata, or the error message on a failure. */
  meta: string;
}

/**
 * Lay a tool row out as `[label][target] … [meta]`.
 *
 * The label and meta columns are fixed so the eye can scan straight down a
 * column of rows; only the target flexes. Below the grid's label threshold the
 * label column collapses and the verb runs inline, because a fixed column would
 * leave nothing for the path.
 */
export function composeToolRow(
  presentation: Pick<ToolPresentation, 'title' | 'target' | 'metadata'>,
  grid: TranscriptGrid,
  extra: { elapsed?: string; error?: string } = {},
): ToolRowColumns {
  const title = shortLabel(presentation.title);
  // Never truncate the verb. A row whose label does not fit the column runs
  // inline instead: `Read sr…` is unreadable in a way `Read src/a.ts` is not.
  const useLabelColumn = grid.label > 0 && displayWidth(title) <= grid.label;
  const metaSource = extra.error
    ? [extra.error]
    : [...presentation.metadata, ...(extra.elapsed ? [extra.elapsed] : [])];

  const label = useLabelColumn ? title.padEnd(grid.label) : '';
  const labelWidth = useLabelColumn ? grid.label + 1 : 0;
  const inlinePrefix = useLabelColumn || !title ? '' : `${title} `;

  // An error message outranks the target it failed on, so a failing row takes
  // as much as the message needs — capped, and never so much that the target
  // drops below a width worth reading.
  const metaBudget = extra.error
    ? Math.max(
        grid.meta,
        Math.min(
          ERROR_META_MAX,
          grid.content - labelWidth - displayWidth(inlinePrefix) - MIN_TARGET_WIDTH - 1,
        ),
      )
    : grid.meta;
  const meta = metaBudget > 0 ? truncateDisplay(joinMetadata(metaSource), metaBudget) : '';

  const metaWidth = displayWidth(meta);
  // The budget covers the whole truncated string, prefix included — subtracting
  // the prefix here as well clipped an inline-label row by exactly the width of
  // its own verb, and `gap` then padded those columns back with spaces.
  const targetBudget = Math.max(4, grid.content - labelWidth - metaWidth - (metaWidth > 0 ? 1 : 0));
  const target = truncateDisplay(`${inlinePrefix}${presentation.target ?? ''}`, targetBudget);

  const used = labelWidth + displayWidth(target) + metaWidth;
  const gap = ' '.repeat(Math.max(metaWidth > 0 ? 1 : 0, grid.content - used));
  return { label, target, gap, meta };
}
