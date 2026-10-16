import type { BackgroundShellStatus } from '../types/runtime.js';
import type { ToolResult } from '../types/tools.js';
import { isTerminalShellStatus } from '../jobs/shell-manager.js';
import { foldControlCharacters as foldShared } from '../control-characters.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import { grepResultMetadata, readResultMetadata } from '../tools/result.js';
import { refusedBeforeRun } from '../tools/pre-execution-codes.js';
import { normalizePersistedTodos, type Todo } from '../tools/todo.js';
import { stepProgress } from './steps.js';
import { STATUS_INDICATORS } from './status-indicators.js';
import { displayWidth, hardWrapLine, truncateDisplay, wordWrap } from './components/word-wrap.js';
import { formatToolOutputFooter, prepareToolOutputDisplay } from './components/tool-output.js';
import {
  CONTENT_COLUMN,
  LABEL_COLUMN_WIDTH,
  MIN_TARGET_WIDTH,
  nestedGrid,
  toolRowTargetOffset,
  type TranscriptGrid,
} from './layout.js';
import {
  isRenderableFileMutationDiff,
  type FileMutationDisplaySummary,
} from './file-mutation-display.js';
import { networkPolicyRefusal } from '../tools/web-policy.js';
import { memoryDisplayPath, type MemoryRootDisplay } from './memory-root.js';

export type TranscriptMode = 'compact' | 'detailed';
export type TranscriptShortcutAction = 'enter-detailed' | 'exit-detailed' | 'expand-output';
export type ToolPresentationStatus = 'running' | 'pending' | 'success' | 'failure' | 'skipped';
export type ToolPreviewType = 'none' | 'text' | 'markdown' | 'diff';

export interface ToolPresentation {
  canonicalName: string;
  status: ToolPresentationStatus;
  /**
   * The registry refused the call before the tool ran: a name no tool answers
   * to, or arguments that did not parse or that the schema refused. Nothing
   * happened in the workspace, so the row reports it without alarm.
   */
  rejected: boolean;
  /** The gutter mark, when it is not the status glyph: a TodoWrite row shows where the plan stands. */
  mark?: string;
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
  /**
   * The argument text of a call the provider could not parse. Its `arguments` are
   * `{}`, so this is the only text there is to show for the row.
   */
  unparsedArguments?: { raw: string; error: string };
  /**
   * Where Book's memory directory is. A file tool's path argument inside it reads
   * `memory/<file>` in the row at every status, not only once a result names it so.
   * A target the result supplies still wins.
   */
  memoryRoot?: MemoryRootDisplay;
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

/**
 * True for the keypress that toggles the keyboard-shortcut reference.
 *
 * A terminal sends US (`0x1f`) for Ctrl+/, and Ink's `parseKeypress` reports
 * that byte as `{ name: '', ctrl: false }` — the sequence reaches `useInput` as
 * `input`, with no `ctrl` flag to gate on. Testing only `key.ctrl && input ===
 * '/'` therefore never matched, so the one shortcut advertised on the welcome
 * screen could not be pressed, while a unit test synthesizing `{ ctrl: true }`
 * passed. Match the raw byte first and keep the flag form for terminals that do
 * report it.
 */
export function isShortcutsToggleKey(
  input: string,
  key: { ctrl?: boolean; meta?: boolean },
): boolean {
  if (input.charCodeAt(0) === 31) return true;
  return Boolean(key.ctrl) && !key.meta && (input === '/' || input === '_');
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
  TodoWrite: 'Steps',
  Task: 'Task',
  InvokeSkill: 'Skill',
  AskUserQuestion: 'Ask',
  ExitPlanMode: 'Plan',
  EnterPlanMode: 'Plan mode',
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

/**
 * Fold a display target onto one line: every run of control characters (C0
 * such as tab, CR and LF, DEL, C1, and the bidi marks and separators) becomes
 * one space. Ordinary spaces are kept as they are, because the row shows what
 * the call acted on: a Grep pattern `^    def ` or a commit message's double
 * space is part of it. One linear pass, so a long raw argument costs its
 * length.
 */
function foldControlCharacters(value: string | undefined): string | undefined {
  return value === undefined ? undefined : foldShared(value);
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

const MEMORY_MAPPED_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * `memory/<file>` for a file tool whose path argument lies in the memory directory: the row's
 * fallback while there is no result, or none that names the file. `undefined` for any other target.
 */
function memoryFileTarget(
  canonicalName: string,
  args: Record<string, unknown>,
  memoryRoot: MemoryRootDisplay | undefined,
): string | undefined {
  if (!memoryRoot || !MEMORY_MAPPED_TOOLS.has(canonicalName)) return undefined;
  const path = stringArg(args, 'filePath', 'file_path', 'notebook_path', 'path');
  return path ? memoryDisplayPath(memoryRoot, path) : undefined;
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
  // Line count only. The byte size rode along on every row that produced any
  // output and told the reader nothing they would act on.
  const lines = countOutputLines(result.content);
  return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
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

/**
 * The exit code a failed result carries, which marks its message as a command's output. Bash
 * records it in `structuredError.details.exitCode`; a failure without one (a timeout, a cancel,
 * a result persisted before the code was recorded) has none, and neither has any other tool.
 */
function commandExitCode(result: ToolResult | undefined): number | undefined {
  const exitCode = result?.structuredError?.details?.exitCode;
  return typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : undefined;
}

/** `exit 1`, for a failed result that carries a non-zero exit code. */
function exitMetadata(
  status: ToolPresentationStatus,
  result: ToolResult | undefined,
): string | undefined {
  if (status !== 'failure') return undefined;
  const exitCode = commandExitCode(result);
  return exitCode === undefined || exitCode === 0 ? undefined : `exit ${exitCode}`;
}

/**
 * `exit 2`, for a BashOutput read of a background shell that finished with a non-zero exit code.
 * The read itself succeeded, so the row keeps its status and mark; the code is the news. It reads
 * the shell record BashOutput returns as the result's `data` (`{ shell, output, remaining }`).
 * `data` is persisted with the result, so a resumed session's rows show it too; it is still
 * unknown here, so every step is checked.
 */
function bashOutputExitMetadata(
  canonicalName: string,
  result: ToolResult | undefined,
): string | undefined {
  if (canonicalName !== 'BashOutput' || result?.status !== 'success') return undefined;
  const shell = (result.data as { shell?: unknown } | null | undefined)?.shell;
  if (typeof shell !== 'object' || shell === null) return undefined;
  const { status, exitCode } = shell as { status?: unknown; exitCode?: unknown };
  if (typeof status !== 'string' || !isTerminalShellStatus(status as BackgroundShellStatus)) {
    return undefined;
  }
  return typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0
    ? `exit ${exitCode}`
    : undefined;
}

/**
 * Put the result's status marker first in a row's metadata, and a failed result's exit code
 * right after it: `failed · exit 1 · 7ms`. It shows by presence of the code, not by tool name.
 * A BashOutput read of a shell that exited non-zero has no marker, so its code leads.
 */
function addStatusMetadata(
  metadata: string[],
  status: ToolPresentationStatus,
  result: ToolResult | undefined,
  canonicalName: string,
): void {
  const statusMetadata = resultStatusMetadata(status);
  if (statusMetadata && !metadata.includes(statusMetadata)) metadata.unshift(statusMetadata);
  const exit = exitMetadata(status, result) ?? bashOutputExitMetadata(canonicalName, result);
  if (exit && !metadata.includes(exit)) metadata.splice(metadata.indexOf('failed') + 1, 0, exit);
}

function fileMutationPresentation(
  canonicalName: string,
  args: Record<string, unknown>,
  result: ToolResult | undefined,
  status: ToolPresentationStatus,
  memoryRoot: MemoryRootDisplay | undefined,
): Pick<ToolPresentation, 'title' | 'target' | 'metadata' | 'previewType' | 'filePath'> {
  const filePath =
    result?.artifacts?.fileMutation?.filePath ??
    memoryFileTarget(canonicalName, args, memoryRoot) ??
    stringArg(args, 'filePath', 'file_path', 'notebook_path', 'path') ??
    getPrimaryArg(args);
  const action =
    result?.artifacts?.fileMutation?.kind === 'create'
      ? 'Create'
      : result?.artifacts?.fileMutation?.kind === 'delete'
        ? 'Delete'
        : 'Edit';
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
  return result?.status === 'success' ? readResultMetadata(args, result.content) : [];
}

function domainFor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

/**
 * A TodoWrite row's columns: the step the call set in flight and where the plan
 * stands, `Reproduce the bug with a failing test   2 of 7 done`. Read from the
 * arguments, so the row says it while the call runs, and scrolling back reads
 * how the plan moved. A call that failed or was refused shows only its status:
 * its arguments are a plan that never happened.
 */
function todoWriteColumns(
  args: Record<string, unknown>,
  status: ToolPresentationStatus,
): { target: string | undefined; metadata: string[]; mark?: string } {
  if (status === 'failure' || status === 'skipped') return { target: undefined, metadata: [] };
  const todos = normalizePersistedTodos(
    Array.isArray(args.todos)
      ? (args.todos as Parameters<typeof normalizePersistedTodos>[0])
      : undefined,
  );
  const mark = status === 'success' ? planMark(todos) : undefined;
  return {
    target: todos.find((todo) => todo.status === 'in_progress')?.content,
    metadata: todos.length > 0 ? [stepProgress(todos)] : [],
    ...(mark ? { mark } : {}),
  };
}

/**
 * Where a plan stands, as the Steps sheet marks it: `◌` set out, `◔` under way,
 * `✓` finished. A TodoWrite row used to carry the call's own `✓`, so
 * `✓ Steps  Clone the repo   0 of 3 done` read as a step done. `undefined` for
 * an empty plan, which keeps the status glyph.
 */
export function planMark(todos: readonly Todo[]): string | undefined {
  if (todos.length === 0) return undefined;
  if (todos.every((todo) => todo.status === 'completed')) return STATUS_INDICATORS.completed.icon;
  if (todos.some((todo) => todo.status !== 'pending')) return STATUS_INDICATORS.in_progress.icon;
  return STATUS_INDICATORS.pending.icon;
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
  // A call the registry refused before it ran: the model addressed the harness
  // wrongly and, as a rule, resends it corrected. A rose row for each one made
  // the loudest marks on screen the ones you could do nothing about.
  // `refusedBeforeRun` is the shared reading, because `invalid_arguments` is also
  // what a tool that did run returns. Refusals (`blocked`) already draw as skipped.
  const rejected = status === 'failure' && refusedBeforeRun(result);
  // TodoWrite's row comes from its arguments, in both paths below.
  const todoColumns = canonicalName === 'TodoWrite' ? todoWriteColumns(args, status) : undefined;
  const mark = todoColumns?.mark;
  const primary = getPrimaryArg(args);
  const mcp = parseMcpToolName(name);
  let title = LABELS[canonicalName] ?? canonicalName;
  let target = primary || undefined;
  let metadata: string[] = [];
  let previewType: ToolPreviewType = result?.content ? 'text' : 'none';
  let filePath: string | undefined;

  if (result?.version === 2 && result.presentation) {
    const structured = result.presentation;
    // `enrichToolResultPresentation` fills in the call's own path argument as the target of a row
    // whose tool named none (a failed Edit, a Read that failed), so a target equal to that echo
    // is the fallback, not a target the result chose.
    const echoesArgs = structured.target === undefined || structured.target === target;
    target =
      (echoesArgs ? memoryFileTarget(canonicalName, args, options.memoryRoot) : undefined) ??
      structured.target ??
      target;
    metadata = [...(structured.metadata ?? [])];
    if (todoColumns) ({ target, metadata } = todoColumns);
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
        mutation.kind === 'create' ? 'Create' : mutation.kind === 'delete' ? 'Delete' : 'Edit';
      filePath = mutation.filePath;
      target = mutation.filePath;
    }
    addStatusMetadata(metadata, status, result, canonicalName);
    // Writing the plan down takes no time worth reading; `0ms` was only noise.
    const duration = todoColumns ? undefined : formatDuration(result.metrics?.durationMs);
    if (duration) metadata.push(duration);
    const retryAttempt = result.metrics?.retryAttempt;
    if (retryAttempt && retryAttempt > 1) metadata.push(`attempt ${retryAttempt}`);
    target = foldControlCharacters(target);
    const hasDetails = Boolean(structured.details);
    return {
      canonicalName,
      status,
      rejected,
      ...(mark ? { mark } : {}),
      title,
      target,
      metadata,
      summary:
        todoColumns || !structured.summary
          ? `${title}${target ? `(${target})` : ''}`
          : structured.summary,
      previewType,
      hasDetails,
      hasHiddenContent: hasDetails,
      filePath,
    };
  }

  if (isFileMutatingTool(canonicalName)) {
    const mutation = fileMutationPresentation(
      canonicalName,
      args,
      result,
      status,
      options.memoryRoot,
    );
    title = mutation.title;
    target = mutation.target;
    metadata = mutation.metadata;
    previewType = mutation.previewType;
    filePath = mutation.filePath;
  } else if (canonicalName === 'Read') {
    target =
      memoryFileTarget(canonicalName, args, options.memoryRoot) ??
      stringArg(args, 'filePath', 'file_path', 'path') ??
      target;
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
      // Grep counts from its own data, which the text cannot be counted back
      // into; only a result persisted by a build that did not have it needs the
      // text fallback (#311).
      const own = result.presentation?.metadata;
      metadata = own?.length ? [...own] : [grepResultMetadata(args, result.content)];
    }
  } else if (canonicalName === 'WebFetch') {
    target = domainFor(stringArg(args, 'url'));
    previewType = result?.content ? 'markdown' : 'none';
  } else if (canonicalName === 'WebSearch') {
    target = stringArg(args, 'query') ?? target;
    previewType = result?.content ? 'markdown' : 'none';
  } else if (canonicalName === 'AskUserQuestion') {
    // `Ask  Fallback, Scope   2 questions`, not the tool's name and nothing else.
    const questions = Array.isArray(args.questions) ? (args.questions as unknown[]) : [];
    const headers = questions
      .map((question) =>
        question &&
        typeof question === 'object' &&
        typeof (question as { header?: unknown }).header === 'string'
          ? (question as { header: string }).header.trim()
          : '',
      )
      .filter(Boolean);
    target = headers.join(', ') || undefined;
    if (questions.length > 0) {
      metadata = [`${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`];
    }
  } else if (canonicalName === 'ExitPlanMode') {
    // `Plan  Fix the timeout fallback   3 steps`: the plan's own title, not its
    // raw markdown squeezed onto one line.
    const plan = stringArg(args, 'plan') ?? '';
    const lines = plan.split('\n').map((line) => line.trim());
    const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line))?.replace(/^#{1,6}\s+/, '');
    target = heading ?? lines.find((line) => line.length > 0);
    const steps = lines.filter((line) => /^\d+[.)]\s/.test(line)).length;
    if (steps > 0) metadata = [`${steps} ${steps === 1 ? 'step' : 'steps'}`];
  } else if (todoColumns) {
    ({ target, metadata } = todoColumns);
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
    // A failed row that names its exit code shows the output under it, so its size is no news.
    const size = exitMetadata(status, result) ? undefined : outputSizeMetadata(result);
    if (size) metadata.push(size);
  }

  addStatusMetadata(metadata, status, result, canonicalName);
  // Writing the plan down takes no time worth reading; `0ms` was only noise.
  const duration = todoColumns ? undefined : formatDuration(result?.metrics?.durationMs);
  if (duration) metadata.push(duration);
  if (result?.metrics?.retryAttempt && result.metrics.retryAttempt > 1)
    metadata.push(`attempt ${result.metrics.retryAttempt}`);

  // A target is shown on one line, in the row and in the summary. A call whose
  // arguments were not valid JSON shows its raw text here, newlines and all — the
  // typed field's text now, the `{__raw}` sentinel's through `getPrimaryArg`.
  target = target || options.unparsedArguments?.raw;
  target = foldControlCharacters(target);
  const targetText = target ? `(${target})` : '';
  const metadataText = metadata.length > 0 ? ` · ${metadata.join(' ')}` : '';
  const summary = `${title}${targetText}${metadataText}`;
  const hasDetails = Boolean(result?.content);

  return {
    canonicalName,
    status,
    rejected,
    ...(mark ? { mark } : {}),
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
    return mutation.kind === 'create' ? 'Create' : mutation.kind === 'delete' ? 'Delete' : 'Edit';
  }
  const mcp = parseMcpToolName(name);
  if (mcp) return mcp.server;
  const canonical = canonicalToolName(name);
  return shortLabel(LABELS[canonical] ?? canonical);
}

/**
 * Standard label-column widths.
 *
 * Nearly every verb is four (`Read`, `Bash`, `Grep`, `Edit`) or six (`Create`,
 * `Delete`); snapping to these means two turns in a row almost always land on
 * the same column, which exact per-turn sizing did not.
 */
const LABEL_COLUMN_STEPS = [4, 6, LABEL_COLUMN_WIDTH] as const;

/** Widest standard label column a run of rows needs, in columns. */
export function toolLabelColumnWidth(labels: readonly string[]): number {
  const widest = labels.reduce((max, label) => Math.max(max, displayWidth(label)), 1);
  return LABEL_COLUMN_STEPS.find((step) => step >= widest) ?? LABEL_COLUMN_WIDTH;
}

/** Labels short enough for the aligned row's fixed label column. */
const SHORT_LABELS: Record<string, string> = {
  'Apply patch': 'Patch',
  'Edit notebook': 'Notebook',
  'Shell output': 'Shell',
};

/** Columns a failed row's metadata may take: `failed · exit 255 · 1m 12s` fits. */
const FAILED_META_WIDTH = 28;

/** The metadata item {@link exitMetadata} writes. */
const EXIT_METADATA = /^exit -?\d+$/;

/** The three aligned columns of a tool row, already padded to the grid. */
export interface ToolRowColumns {
  /** Verb, padded to the grid's label column. Empty when labels are inline. */
  label: string;
  /** What the tool acted on, truncated to fit. */
  target: string;
  /** Spaces that push `meta` flush against the right edge. */
  gap: string;
  /** Right-aligned result metadata. A failure's message is laid out under the row instead. */
  meta: string;
}

/**
 * Whether a row's verb takes the aligned label column. Never truncate the
 * verb: a row whose label does not fit the column runs inline instead, because
 * `Read sr…` is unreadable in a way `Read src/a.ts` is not.
 */
function usesLabelColumn(title: string, grid: TranscriptGrid): boolean {
  return grid.label > 0 && displayWidth(title) <= grid.label;
}

/**
 * Lay a tool row out as `[label][target] … [meta]`.
 *
 * The label and meta columns are fixed so the eye can scan straight down a
 * column of rows; only the target flexes. A quiet-run summary, which opts in
 * with `metaMayGrow`, may widen its meta column into the target columns a short
 * target leaves free. Below the grid's label threshold the label column
 * collapses and the verb runs inline, because a fixed column would leave
 * nothing for the path.
 */
export function composeToolRow(
  presentation: Pick<ToolPresentation, 'title' | 'target' | 'metadata'>,
  grid: TranscriptGrid,
  extra: { elapsed?: string; metaMayGrow?: boolean } = {},
): ToolRowColumns {
  const title = shortLabel(presentation.title);
  const useLabelColumn = usesLabelColumn(title, grid);
  const metaSource = [...presentation.metadata, ...(extra.elapsed ? [extra.elapsed] : [])];

  const label = useLabelColumn ? title.padEnd(grid.label) : '';
  const labelWidth = useLabelColumn ? grid.label + 1 : 0;
  const inlinePrefix = useLabelColumn || !title ? '' : `${title} `;

  // Aligned rows lay out inside the grid's bounded row measure even when the
  // prose around them takes the whole terminal. Right-aligning `67ms` against
  // column 197 does not align it with the command it timed -- it just puts it
  // far away, with a gap of pure padding rebuilt on every streamed frame in
  // between. The bound lives on the grid so it narrows with nesting.
  const measure = grid.row;

  // A row's metadata with an exit code, `failed · exit 1 · 7ms` or a shell read's
  // `exit 2 · 12 lines · 7ms`, runs past the grid's 20-column meta column, and the duration is
  // what a cut there would take. It gets room for them, never more than two fifths of the row.
  // Rows without an exit code keep the column unless the caller opts in to growth.
  const fixedMetaBudget =
    grid.meta > 0 && metaSource.some((part) => EXIT_METADATA.test(part))
      ? Math.max(grid.meta, Math.min(FAILED_META_WIDTH, Math.floor(measure * 0.4)))
      : grid.meta;

  // The target is a tool argument: it may hold a newline, an ESC, or a bidi
  // override, none of which survive a one-line row.
  const fullTarget = `${inlinePrefix}${foldControlCharacters(presentation.target) ?? ''}`;

  // A quiet summary's metadata may grow into the columns a short target leaves empty, so
  // `1 file · 1 search · 1 listing` on `Read a.js` is not cut at the meta column. It takes only
  // what is left after the label, the whole target and the gap, so a target that needs its
  // columns keeps them and the metadata stays at its fixed budget. The target is measured here
  // once, and only for a row that may grow.
  let targetWidth: number | undefined;
  let metaBudget = fixedMetaBudget;
  if (extra.metaMayGrow && grid.meta > 0) {
    targetWidth = displayWidth(fullTarget);
    metaBudget = Math.max(fixedMetaBudget, measure - labelWidth - targetWidth - 1);
  }
  const meta = metaBudget > 0 ? truncateDisplay(joinMetadata(metaSource), metaBudget) : '';

  const metaWidth = displayWidth(meta);
  // The budget covers the whole truncated string, prefix included — subtracting
  // the prefix here as well clipped an inline-label row by exactly the width of
  // its own verb, and `gap` then padded those columns back with spaces.
  const targetBudget = Math.max(4, measure - labelWidth - metaWidth - (metaWidth > 0 ? 1 : 0));
  const fitWidth =
    targetWidth !== undefined && targetWidth <= targetBudget ? targetWidth : undefined;
  const target = fitWidth === undefined ? truncateDisplay(fullTarget, targetBudget) : fullTarget;

  const used = labelWidth + (fitWidth ?? displayWidth(target)) + metaWidth;
  const gap = ' '.repeat(Math.max(metaWidth > 0 ? 1 : 0, measure - used));
  return { label, target, gap, meta };
}

/** The key that shows a truncated row in full. */
export const EXPAND_KEY = 'Ctrl+E';

/**
 * What `mutationDiffPreview` is given for a mutation row. One new file previews its first lines;
 * any other diff is previewed by transcript mode. The one copy of that rule: the row draws its
 * diff from it and the Ctrl+E target asks whether the same diff hides rows.
 */
export function mutationDiffPreviewInput(
  mutationSummary: Pick<FileMutationDisplaySummary, 'kind' | 'fileCount'> | undefined,
  view: { transcriptMode: TranscriptMode; screenReader: boolean },
): { createsSingleNewFile: boolean; transcriptMode: TranscriptMode; screenReader: boolean } {
  return {
    createsSingleNewFile:
      mutationSummary?.kind === 'create' && (mutationSummary.fileCount ?? 1) <= 1,
    transcriptMode: view.transcriptMode,
    screenReader: view.screenReader,
  };
}

/** Most rows a failure's message takes under its tool row. */
export const TOOL_ERROR_MAX_LINES = 2;

/** Most source lines of a failed command's output shown under its row: the last ones. */
export const TOOL_ERROR_TAIL_LINES = 4;

/** Most rows the sandbox note a command's output ends with takes under the tail. */
export const TOOL_ERROR_NOTE_LINES = 2;

/** Rows of a failed command's detail at most: the `… +N lines` hint, the tail, the note. */
export const TOOL_ERROR_COMMAND_MAX_ROWS = 1 + TOOL_ERROR_TAIL_LINES + TOOL_ERROR_NOTE_LINES;

/**
 * Most lines (rows, once a long line wraps) of output an expanded row shows. OutputBlock puts this
 * bound on `showAllToolOutput` and an expanded error detail keeps to it, so a runaway output cannot
 * flood the transcript.
 */
export const EXPANDED_OUTPUT_MAX_LINES = 2000;

/** Rows of an expanded failed command's detail at most: the hint, the output, the note. */
export const TOOL_ERROR_EXPANDED_MAX_ROWS = 1 + EXPANDED_OUTPUT_MAX_LINES + TOOL_ERROR_NOTE_LINES;

/** The line Book's sandbox appends to a command's message: `withReadOnlyGitDirNote` and kin. */
const SANDBOX_NOTE_PREFIX = 'Note: ';

/** What the shell tool writes when the command printed nothing on stderr. */
const EXIT_CODE_ONLY = /^Exit code: -?\d+$/;

/** A failure's message as the lines it takes under its tool row. */
export interface ToolErrorDetail {
  /**
   * Columns from the row's left edge, status gutter included, to the message:
   * under the target the row failed on when it has a label column and a target.
   * A row with no target has it under the verb, rather than hanging under an
   * empty column, and so does one too narrow to leave the message a readable
   * measure there.
   */
  column: number;
  /**
   * `… +36 lines (Ctrl+E)`: how many of a command's output lines are hidden above `lines`,
   * and the key that shows them. An expanded detail names no key: `… +500 lines`. Set only
   * when the output kept its tail and the row budget had room for it; it reads before the
   * rows, as the lines it stands for did.
   *
   * A collapsed detail whose rows are a stderr message, with no hidden lines of its own, names the
   * command's stdout instead: `… +1 line of output (Ctrl+E)`, with {@link hintBelow} set. A row
   * draws one such footer, so the rows' own count of what they cut wins.
   */
  hint?: string;
  /** `hint` counts the command's stdout, which `lines` do not show: it reads after the rows. */
  hintBelow?: boolean;
  /**
   * A message word-wrapped to the row's measure, the last line ending in `…` when more was
   * cut; a failed command's output as its last {@link TOOL_ERROR_TAIL_LINES} non-blank
   * lines, one row each (all of them when expanded, a line wider than the row continuing on the
   * rows after it). Empty when a command failed with nothing to show but its exit code.
   */
  lines: string[];
  /**
   * The sandbox note a command's message ends with, word-wrapped to at most
   * {@link TOOL_ERROR_NOTE_LINES} rows. It reads after `lines` and is drawn like them.
   */
  note?: string[];
}

export interface ToolErrorDetailOptions {
  /**
   * The message is a command's output (the result carries an exit code): it keeps the shape of
   * its lines and shows the last of them. Anything else is prose: folded, word-wrapped, cut.
   */
  commandOutput?: boolean;
  /**
   * The command's stdout, shown instead of a message that is only `Exit code: N`. Under any other
   * message a collapsed detail counts its non-blank lines in a footer, `… +1 line of output`.
   */
  stdout?: string;
  /**
   * The row's output block draws `stdout` under the detail. An expanded detail then shows no stdout
   * fallback, which would draw the same lines twice. A collapsed one still tails that fallback, but
   * names no stdout under a stderr message: the block counts what it cuts itself.
   */
  stdoutShownBelow?: boolean;
  /**
   * The key the collapsed hint names: `… +36 lines (Ctrl+E)`. Defaults to `Ctrl+E`; `''` keeps
   * the footer and drops the key, for a row Ctrl+E does not currently target.
   */
  expandHint?: string;
  /**
   * Show the whole failure, not its tail: the row was expanded (Ctrl+E). A command's output keeps
   * its last {@link EXPANDED_OUTPUT_MAX_LINES} rows, a line wider than the row continuing on the
   * rows after it; prose wraps with no two-row cap, to as many rows. The collapsed hint names the
   * key that gets here, so the expanded one does not.
   */
  expanded?: boolean;
  /**
   * Most rows the detail may take. Defaults to {@link TOOL_ERROR_COMMAND_MAX_ROWS} for a
   * command's output and to {@link TOOL_ERROR_MAX_LINES} for prose; expanded, to what
   * {@link EXPANDED_OUTPUT_MAX_LINES} lines, the hint and the note take. The hint goes first
   * when it does not fit, then the tail's top rows.
   */
  maxRows?: number;
}

/**
 * How {@link composeToolErrorDetail} should read a result's message: as a command's output
 * when the result carries an exit code, as prose otherwise.
 */
export function toolErrorDetailOptions(result: ToolResult | undefined): ToolErrorDetailOptions {
  return commandExitCode(result) === undefined
    ? {}
    : { commandOutput: true, stdout: result?.content };
}

/** Word-wrap prose to `width`, at most `maxLines` rows, the last one ending in `…` when cut. */
function wrapProse(text: string, width: number, maxLines: number): string[] {
  const wrapped = wordWrap(text, width).split('\n');
  if (wrapped.length <= maxLines) return wrapped;
  const lines = wrapped.slice(0, maxLines);
  // The last kept line carries the rest so `…` lands where the text was cut.
  lines[maxLines - 1] = truncateDisplay(
    `${lines[maxLines - 1]} ${wrapped.slice(maxLines).join(' ')}`,
    width,
  );
  return lines;
}

/** Output's lines with their control characters neutralised, and the blank ones dropped. */
function nonBlankOutputLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const folded = foldShared(line);
    if (folded.trim() !== '') lines.push(folded);
  }
  return lines;
}

/**
 * The last rows of `lines`, each wrapped at display width `width`, at most `budget` of them, and
 * how many source lines they show whole. A line the budget cuts into keeps its last rows.
 */
function wrappedTail(
  lines: readonly string[],
  width: number,
  budget: number,
): { rows: string[]; wholeLines: number } {
  const blocks: string[][] = [];
  let count = 0;
  let wholeLines = 0;
  for (let index = lines.length - 1; index >= 0 && count < budget; index--) {
    const wrapped = hardWrapLine(lines[index]!, width);
    const room = budget - count;
    if (wrapped.length <= room) wholeLines++;
    const block = wrapped.length <= room ? wrapped : wrapped.slice(-room);
    blocks.push(block);
    count += block.length;
  }
  return { rows: blocks.reverse().flat(), wholeLines };
}

/**
 * `… +1 line of output (Ctrl+E)`: how many non-blank lines of a failed command's stdout are not
 * under its row, for a detail whose rows are the stderr. Undefined when stdout has none.
 */
function hiddenStdoutHint(stdout: string, expandHint: string): string | undefined {
  const hiddenLines = nonBlankOutputLines(stdout).length;
  return hiddenLines > 0
    ? formatToolOutputFooter({ hiddenLines, truncatedLines: 0, hint: expandHint, of: 'output' })
    : undefined;
}

/** A failed command's output as hint, tail rows and note, inside `maxRows`. */
function commandOutputDetail(
  error: string,
  stdout: string,
  width: number,
  column: number,
  maxRows: number,
  expanded: boolean,
  stdoutShownBelow: boolean,
  expandHint: string,
): ToolErrorDetail {
  const messageLines = nonBlankOutputLines(error);
  // Book's own note ends the message. It is advice for the reader, not output: it keeps rows of
  // its own instead of taking one of the tail's.
  const noteLine = messageLines.at(-1)?.startsWith(SANDBOX_NOTE_PREFIX)
    ? messageLines.pop()
    : undefined;
  // Many test runners print their verdict on stdout and leave stderr empty, and the shell tool
  // then reports only `Exit code: N`, which the row's metadata already says.
  const stdoutFallback = messageLines.length === 1 && EXIT_CODE_ONLY.test(messageLines[0]!.trim());
  const source = stdoutFallback
    ? expanded && stdoutShownBelow
      ? []
      : nonBlankOutputLines(stdout)
    : messageLines;

  // The note gives way to the tail's last row, never the other way round.
  const noteCap = Math.min(
    TOOL_ERROR_NOTE_LINES,
    Math.max(0, maxRows - (source.length > 0 ? 1 : 0)),
  );
  const note =
    noteLine !== undefined && noteCap > 0 ? wrapProse(noteLine.trim(), width, noteCap) : [];
  const budget = Math.min(
    expanded ? EXPANDED_OUTPUT_MAX_LINES : TOOL_ERROR_TAIL_LINES,
    Math.max(0, maxRows - note.length),
  );
  // Expanded, a long line continues on the rows after it instead of being cut, so the rows are
  // wrapped here and the display only counts what stays out of them.
  const wrapped = expanded ? wrappedTail(source, width, budget) : undefined;
  const tail = prepareToolOutputDisplay(source.join('\n'), {
    maxLines: wrapped ? wrapped.wholeLines : budget,
    maxLineWidth: wrapped ? Number.MAX_SAFE_INTEGER : width,
    hint: expanded ? undefined : expandHint,
    strategy: 'tail',
  });
  const lines = wrapped ? wrapped.rows : tail.lines;
  // Under a stderr message a collapsed row says nothing of the stdout unless this footer does, and
  // Ctrl+E skips a row that hides nothing. The tail's own count of the lines it cut comes first: a
  // row draws one footer and names the key once. There is none when the stdout is the rows (an
  // exit-code-only message) or an open row's output block draws it.
  const stdoutHint =
    tail.hiddenLines === 0 && !stdoutFallback && !expanded && !stdoutShownBelow
      ? hiddenStdoutHint(stdout, expandHint)
      : undefined;
  const hint = stdoutHint ?? (tail.hiddenLines > 0 ? tail.footer : undefined);
  const showHint = hint !== undefined && lines.length + note.length + 1 <= maxRows;
  return {
    column,
    ...(showHint ? { hint, ...(stdoutHint ? { hintBelow: true } : {}) } : {}),
    lines,
    ...(note.length > 0 ? { note } : {}),
  };
}

/**
 * Lay a failure's message out under its row.
 *
 * The message used to replace the row's metadata and was cut to that column —
 * `Invalid arguments for TodoWrite: arguments.todos is required. A…` — so the
 * part that said what was wrong was the part that went. It now starts under
 * the target, on the row's own grid, and wraps to the row's measure for up to
 * {@link TOOL_ERROR_MAX_LINES} lines. The text is the model's own or a tool's,
 * so its control characters are folded first: a newline, an ESC or a bidi
 * override must not reach the screen.
 *
 * A failed command's output (`options.commandOutput`) has line structure, and its end is the
 * part that says what failed: one row per non-blank line, cut at the row's measure, the last
 * ones. An expanded detail (`options.expanded`) shows all of them, up to
 * {@link EXPANDED_OUTPUT_MAX_LINES} rows, and wraps a wider line onto the rows after it.
 */
export function composeToolErrorDetail(
  row: Pick<ToolPresentation, 'title' | 'target'>,
  error: string,
  grid: TranscriptGrid,
  options: ToolErrorDetailOptions = {},
): ToolErrorDetail {
  const underTarget =
    Boolean(row.target) &&
    usesLabelColumn(shortLabel(row.title), grid) &&
    grid.row - grid.label - 1 >= MIN_TARGET_WIDTH;
  const indent = underTarget ? grid.label + 1 : 0;
  // Never wider than the row has room for: a line Ink cut at the box edge would
  // lose the middle of the message, past the reach of the `…` below.
  const width = Math.max(1, grid.row - indent);
  const column = toolRowTargetOffset(grid, underTarget);
  const expanded = options.expanded === true;
  if (options.commandOutput) {
    return commandOutputDetail(
      error,
      options.stdout ?? '',
      width,
      column,
      options.maxRows ?? (expanded ? TOOL_ERROR_EXPANDED_MAX_ROWS : TOOL_ERROR_COMMAND_MAX_ROWS),
      expanded,
      options.stdoutShownBelow === true,
      options.expandHint ?? EXPAND_KEY,
    );
  }
  const text = (foldControlCharacters(error) ?? '').trim();
  return {
    column,
    lines: wrapProse(
      text,
      width,
      options.maxRows ?? (expanded ? EXPANDED_OUTPUT_MAX_LINES : TOOL_ERROR_MAX_LINES),
    ),
  };
}

/**
 * A blocked result shows its reason only for a network-policy refusal or a stopped cross-origin
 * redirect, which the user needs to understand. `networkPolicyRefusal` classifies both, and the
 * loop's stop message uses the same classifier.
 */
export function showsErrorMessage(result: ToolResult | undefined): boolean {
  if (!result?.structuredError) return false;
  return result.status !== 'blocked' || networkPolicyRefusal(result) !== undefined;
}

export interface ResultErrorDetailInput {
  presentation: Pick<ToolPresentation, 'title' | 'target'>;
  /** The message the row shows: `result.structuredError.message`. */
  message: string;
  result: ToolResult | undefined;
  /** The grid the row itself is laid out on. */
  rowGrid: TranscriptGrid;
  /** The row sits under an aggregate mutation heading, on the nested grid. */
  isFileChild: boolean;
  expanded: boolean;
  /** The row's output block draws a command's stdout in full under the detail. */
  stdoutShownBelow: boolean;
  expandHint?: string;
}

/**
 * A failed row's error detail, composed the one way ToolCallBlock draws it and the one way the
 * Ctrl+E target is chosen. A command that failed with no output has nothing to show: undefined.
 */
export function composeResultErrorDetail({
  presentation,
  message,
  result,
  rowGrid,
  isFileChild,
  expanded,
  stdoutShownBelow,
  expandHint,
}: ResultErrorDetailInput): ToolErrorDetail | undefined {
  // A result with an exit code carries a command's output; its message keeps its lines.
  const options: ToolErrorDetailOptions = {
    ...toolErrorDetailOptions(result),
    expanded,
    stdoutShownBelow,
    ...(expandHint === undefined ? {} : { expandHint }),
  };
  const detail = isFileChild
    ? composeToolErrorDetail(
        { title: '', target: undefined },
        message,
        nestedGrid(rowGrid),
        options,
      )
    : composeToolErrorDetail(presentation, message, rowGrid, options);
  return detail.lines.length > 0 || detail.note ? detail : undefined;
}

/** Everything {@link toolOutputDisplay} needs to preview a row's output block. */
export interface ToolOutputDisplayInput {
  success: boolean;
  /** The row is shown in full: the large rendering ceiling instead of a short preview. */
  showAllToolOutput: boolean;
  /** The block's width: the row grid's content width, outer indentation included. */
  terminalWidth: number;
  /** The key the footer names; `''` for none. */
  expandHint?: string;
}

/** Columns of the output block's content: the rail's border plus its padding take the gutter. */
export function toolOutputContentWidth(terminalWidth: number): number {
  return Math.max(8, Math.floor(terminalWidth) - CONTENT_COLUMN - 2);
}

/** The preview OutputBlock draws for a row's output; the Ctrl+E target reads the same one. */
export function toolOutputDisplay(output: string, input: ToolOutputDisplayInput) {
  const { success, showAllToolOutput, terminalWidth, expandHint = EXPAND_KEY } = input;
  return prepareToolOutputDisplay(output, {
    maxLines: showAllToolOutput ? EXPANDED_OUTPUT_MAX_LINES : success ? 6 : 10,
    maxLineWidth: toolOutputContentWidth(terminalWidth),
    hint: showAllToolOutput ? undefined : expandHint || undefined,
    strategy: showAllToolOutput ? 'head' : success ? 'head-tail' : 'tail',
  });
}

/** The last `max` non-blank lines of `text`, read from its end: the cost is theirs, not its size. */
function lastNonBlankLines(text: string, max: number): string[] {
  const found: string[] = [];
  let end = text.length;
  while (end > 0 && found.length < max) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    if (line.trim() !== '') found.push(line);
    end = start - 1;
  }
  return found.reverse();
}

/**
 * How many rows a result's error detail draws, without a width or a walk of its output: 0 for a
 * result that did not fail, {@link TOOL_ERROR_MAX_LINES} for prose, and for a command's output
 * the hint and tail (at most one row per non-blank line) plus the note's rows. The hint is one row
 * whether it counts the stderr lines the tail cut or the stdout a stderr message leaves out.
 * Follows {@link composeToolErrorDetail}'s rules; the virtual transcript sizes its spacers from it.
 */
export function estimateToolErrorDetailRows(result: ToolResult | undefined): number {
  if (!result || result.status === 'success' || !result.structuredError) return 0;
  if (commandExitCode(result) === undefined) return TOOL_ERROR_MAX_LINES;
  const lines = lastNonBlankLines(result.structuredError.message, TOOL_ERROR_TAIL_LINES + 1 + 1);
  let noteRows = 0;
  if (lines.at(-1)?.startsWith(SANDBOX_NOTE_PREFIX)) {
    lines.pop();
    noteRows = TOOL_ERROR_NOTE_LINES;
  }
  const stdoutIsRows = lines.length === 1 && EXIT_CODE_ONLY.test(lines[0]!.trim());
  const shown = stdoutIsRows
    ? lastNonBlankLines(result.content ?? '', TOOL_ERROR_TAIL_LINES + 1).length
    : lines.length;
  // Under a stderr message, any stdout takes the hint's row when the tail cut nothing of its own.
  const stdoutRow =
    !stdoutIsRows && shown + noteRows > 0 && lastNonBlankLines(result.content ?? '', 1).length > 0
      ? 1
      : 0;
  return Math.min(TOOL_ERROR_TAIL_LINES + 1, shown + stdoutRow) + noteRows;
}
