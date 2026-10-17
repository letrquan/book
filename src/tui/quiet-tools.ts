import { basename, isAbsolute, relative, resolve } from 'path';
import { isTerminalShellStatus } from '../jobs/shell-manager.js';
import { splitReasoningParts } from '../reasoning-tags.js';
import { canonicalToolName } from '../tools/aliases.js';
import type { Message } from '../types/messages.js';
import type { BackgroundShellStatus } from '../types/runtime.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { isWorkStep } from './components/transcript-messages.js';
import {
  classifyReadOnlyShellCommand,
  shellCommandPaths,
  type ReadOnlyShellPart,
} from './shell-readonly.js';

/**
 * Quiet tools: the reading an agent does on its way to a change.
 *
 * A turn that reads six files and runs two searches before one edit used to
 * draw nine rows, and the edit, which is the row the reader needs, sat at the
 * bottom of a column of reads. In the compact transcript a run of these
 * collapses into one summary row. What changes something, runs a command,
 * reaches the network, delegates, fails or waits on a permission prompt keeps
 * its own row.
 *
 * `Bash` is not in this set, because a shell command can change anything. It
 * joins a run one call at a time, through `classifyReadOnlyShellCommand`: a
 * conservative parser that accepts only a command it can prove read-only (`cat`,
 * `rg`, `ls`, `find` without actions, ...) and rejects expansion, redirection,
 * background jobs and every wrapper. Read-only `git` (`status`, `log`, `diff`,
 * `show`, `grep`, `ls-files` and `branch` in its listing forms) is on its
 * allow-list, so it folds like Book's own Git tools do; folding only changes how
 * a command that already ran is drawn. Anything the parser cannot prove keeps its
 * own row, as does a read-only command that failed (`git diff --exit-code`
 * exiting 1 included), ran in the background (or was moved there at its timeout)
 * or names a path outside the workspace.
 */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'GitStatus',
  'GitDiff',
  'GitLog',
  'GitBranch',
  'ToolSearch',
  'TaskList',
  'TaskGet',
  'BashOutput',
  'SessionHistorySearch',
  'SessionHistoryRead',
  'ReadSkillResource',
]);

/** Tools that search rather than read, for the summary's wording. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Glob', 'Grep']);

export interface QuietToolContext {
  /**
   * Tools the user has singled out: an explicit expansion, or the row they
   * selected. A pinned tool always keeps its own row, so nothing they asked to
   * see can end up inside a summary.
   */
  pinned: ReadonlySet<string>;
  /** The tool a permission prompt is waiting on, which is never quiet. */
  pendingToolId?: string;
  /**
   * The session's workspace. A read or search that reaches outside it is the
   * kind of access a permission rule exists for, so it keeps its own row even
   * when no prompt was shown (bypass mode, or an allow rule).
   */
  workspace?: string;
  /**
   * Classifies a shell command. The transcript asks again for the same command on
   * every render, so a context that lives across renders carries a memo
   * (`createShellPartsMemo`); without one the classifier is called directly.
   */
  shellParts?: (command: string) => ReadOnlyShellPart[] | undefined;
}

/**
 * A bounded per-command memo of `classifyReadOnlyShellCommand`, for a
 * `QuietToolContext` to carry. It lives and dies with the context that holds it.
 */
export function createShellPartsMemo(
  limit = 256,
): (command: string) => ReadOnlyShellPart[] | undefined {
  const memo = new Map<string, ReadOnlyShellPart[] | undefined>();
  return (command) => {
    if (memo.has(command)) return memo.get(command);
    const parts = classifyReadOnlyShellCommand(command);
    if (memo.size >= limit) memo.delete(memo.keys().next().value!);
    memo.set(command, parts);
    return parts;
  };
}

function shellPartsFor(
  context: QuietToolContext | undefined,
  command: string,
): ReadOnlyShellPart[] | undefined {
  return (context?.shellParts ?? classifyReadOnlyShellCommand)(command);
}

/** Whether a result reports a command that outlived its timeout and was moved to a background shell. */
function wasBackgrounded(result: ToolResult | undefined): boolean {
  const data = result?.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { backgrounded?: unknown }).backgrounded === true
  );
}

/** Whether `target`, resolved from `base`, lies outside the workspace. */
function escapesWorkspace(workspace: string, base: string, target: string): boolean {
  const rel = relative(resolve(workspace), resolve(base, target));
  return rel.startsWith('..') || isAbsolute(rel);
}

/** Whether a read or search reaches outside the workspace. */
function reachesOutside(call: ToolCall, workspace: string | undefined): boolean {
  if (!workspace) return false;
  const target = argString(call.arguments, 'file_path', 'path', 'filePath');
  if (!target) return false;
  return escapesWorkspace(workspace, workspace, target);
}

/**
 * What a `Bash` call reads, searches and lists when it is read-only, or
 * undefined when it keeps its own row: a command the classifier cannot prove
 * harmless, a background job, or one that names a path (or runs in a directory)
 * outside the workspace. Relative paths resolve from the call's `workdir`.
 */
function readOnlyShellParts(
  call: ToolCall,
  context: QuietToolContext,
): ReadOnlyShellPart[] | undefined {
  const { workspace } = context;
  const command = call.arguments.command;
  if (typeof command !== 'string') return undefined;
  if (call.arguments.run_in_background === true || call.arguments.runInBackground === true) {
    return undefined;
  }
  const parts = shellPartsFor(context, command);
  if (!parts || !workspace) return parts;
  const workdir = argString(call.arguments, 'workdir');
  if (workdir && escapesWorkspace(workspace, workspace, workdir)) return undefined;
  const base = resolve(workspace, workdir ?? '.');
  return shellCommandPaths(parts).some((path) => escapesWorkspace(workspace, base, path))
    ? undefined
    : parts;
}

const NO_STDERR_EXIT_ONE = 'Exit code: 1';

/**
 * Whether a result is a search that found nothing: `grep`, `rg`, `ag`, `fd` and friends exit 1
 * when nothing matches, and Bash reports any non-zero exit as a failure. That is the normal
 * outcome of a search, so it folds like a success.
 *
 * It must be exactly that: a failed `error` result (not blocked, cancelled or timed out) whose
 * recorded exit code is 1, from a command whose every part is a search, and that wrote nothing
 * to stderr. shell.ts reports a failed command's message as its stderr, or `Exit code: N` when
 * there is none, so a message that is exactly `Exit code: 1` is the one way to tell the
 * command was silent on stderr; anything else (a bad regex, a missing path, a sandbox denial)
 * keeps its row.
 */
function isNoMatchSearch(parts: readonly ReadOnlyShellPart[], result: ToolResult): boolean {
  if (result.status !== 'error') return false;
  if (parts.length === 0 || !parts.every((part) => part.kind === 'search')) return false;
  const error = result.structuredError;
  return error?.details?.exitCode === 1 && error.message.trim() === NO_STDERR_EXIT_ONE;
}

function isNonZeroExit(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

/**
 * Whether a result reports a non-zero exit code, which is news a summary would bury: a BashOutput
 * read of a background shell that finished non-zero (the read succeeded; `exit N` is the news,
 * see `bashOutputExitMetadata` in tool-presentation.ts), or, defensively, any result whose
 * structured error records one. `data` is persisted and unknown here, so every step is checked.
 */
function reportsNonZeroExit(name: string, result: ToolResult | undefined): boolean {
  if (!result) return false;
  if (isNonZeroExit(result.structuredError?.details?.exitCode)) return true;
  if (name !== 'BashOutput') return false;
  const shell = (result.data as { shell?: unknown } | null | undefined)?.shell;
  if (typeof shell !== 'object' || shell === null) return false;
  const { status, exitCode } = shell as { status?: unknown; exitCode?: unknown };
  return (
    typeof status === 'string' &&
    isTerminalShellStatus(status as BackgroundShellStatus) &&
    isNonZeroExit(exitCode)
  );
}

function resultFor(message: Message, toolCallId: string): ToolResult | undefined {
  return message.toolResults?.find((result) => result.toolCallId === toolCallId);
}

/**
 * Whether one call may fold into a summary.
 *
 * A running call may: it joins the run and the summary carries the spinner, so
 * the row does not appear and then vanish when the call finishes. A finished
 * call must have succeeded; a failure, a refusal or a cancellation is news, and so
 * is a result that reports a non-zero exit code.
 */
export function isQuietInvocation(
  call: ToolCall,
  result: ToolResult | undefined,
  message: Message,
  context: QuietToolContext,
): boolean {
  const name = canonicalToolName(call.name);
  let noMatchSearch = false;
  if (name === 'Bash') {
    const parts = readOnlyShellParts(call, context);
    if (!parts) return false;
    noMatchSearch = result !== undefined && isNoMatchSearch(parts, result);
    // A foreground command still running at its timeout is adopted as a background
    // shell and reported as a success; it is a job to watch, not a read.
    if (wasBackgrounded(result)) return false;
  } else if (!QUIET_TOOLS.has(name)) {
    return false;
  }
  if (context.pinned.has(call.id) || context.pendingToolId === call.id) return false;
  if (reachesOutside(call, context.workspace)) return false;
  if (message.nestedToolInvocations?.some((nested) => nested.parentTraceId === call.id)) {
    return false;
  }
  // The no-match search is a Bash call whose exit 1 is the normal outcome; it is exempt.
  if (!noMatchSearch && reportsNonZeroExit(name, result)) return false;
  return !result || result.status === 'success' || noMatchSearch;
}

function isAssistantTurn(message: Message): boolean {
  return message.role === 'assistant' && !message.localCommand;
}

/**
 * Whether a message carries markdown prose: the one kind of text that breaks a
 * quiet run. Judged on `content`, the way AgentMessage splits it: routers that
 * inline reasoning put `<think></think>` in the content of nearly every
 * tool-call turn, and that is not prose. A step that speaks keeps its thought.
 */
export function hasProse(message: Message): boolean {
  return splitReasoningParts(message.content ?? '', { concluded: false }).some(
    (part) => part.kind === 'markdown' && part.text.trim().length > 0,
  );
}

/**
 * A per-message memo of {@link hasProse}, for a component that asks again on every
 * render. A message is parsed once while its object and its content stay the same;
 * the streaming message is a new object on every delta, so it is parsed again.
 */
export function createProseMemo(
  parse: (message: Message) => boolean = hasProse,
): (message: Message) => boolean {
  const memo = new WeakMap<Message, { content: string; prose: boolean }>();
  return (message) => {
    const content = message.content ?? '';
    const cached = memo.get(message);
    if (cached && cached.content === content) return cached.prose;
    const prose = parse(message);
    memo.set(message, { content, prose });
    return prose;
  };
}

/**
 * The thoughts a message carries as text: its native `reasoningContent` and the
 * non-blank `<think>` parts of its content.
 */
function thoughtsOf(message: Message): string[] {
  return [
    message.reasoningContent,
    ...splitReasoningParts(message.content ?? '', { concluded: false })
      .filter((part) => part.kind === 'think')
      .map((part) => part.text),
  ].filter((value): value is string => Boolean(value?.trim()));
}

/**
 * Whether the compact transcript hides this message's thoughts: a step of work,
 * by the transcript's own definition ({@link isWorkStep}), quiet or not. The
 * thought behind a call is process, and the row it led to says what happened. A
 * message with no call, or whose calls only keep the task list or hand the turn
 * back (`TodoWrite`, `AskUserQuestion`, ...), is an answer and keeps its thought
 * row. Detailed mode and screen readers keep every thought, and so does a step
 * whose call waits on a permission prompt; the caller applies those.
 */
export function hidesThoughtsInCompact(message: Message): boolean {
  return isWorkStep(message);
}

/**
 * An assistant message with no prose of its own that continues a run begun
 * before it.
 *
 * Only the first call has to be quiet. Book already folds a tool-only turn with
 * blank content into the turn before it, so the turn that ends a run of reads
 * often carries the edit that follows them, as `[Read, Edit]`. Requiring every
 * call to be quiet would leave that last read stranded on its own row. The
 * message joins whole; the rows it draws still keep the edit apart (see
 * {@link groupQuietInvocations}).
 *
 * Whether the message reasons does not matter: the compact transcript hides a
 * step's thought, so the rows group the same with and without one.
 */
export function continuesQuietRun(message: Message, context: QuietToolContext): boolean {
  if (!isAssistantTurn(message)) return false;
  const first = message.toolCalls?.[0];
  if (!first) return false;
  if (hasProse(message)) return false;
  // Joining would put a spawn in the same entry as the narration before it,
  // and AgentMessage hides a delegating entry's narration.
  if (message.toolCalls!.some((call) => call.name === 'AgentSpawn')) return false;
  return isQuietInvocation(first, resultFor(message, first.id), message, context);
}

function endsWithQuietCall(message: Message, context: QuietToolContext): boolean {
  if (message.role !== 'assistant' || message.localCommand) return false;
  const calls = message.toolCalls ?? [];
  const last = calls[calls.length - 1];
  return Boolean(last && isQuietInvocation(last, resultFor(message, last.id), message, context));
}

export interface CollapsedTimeline<T> {
  entries: T[];
  /** For a merged entry, keyed by its (first) id: every message folded into it, in order. */
  sourceIds: ReadonlyMap<string, readonly string[]>;
}

type TimelineEntry = Message | { transcriptOrdinal: unknown };

function isMessage(entry: TimelineEntry | undefined): entry is Message {
  return Boolean(entry && 'role' in entry);
}

/**
 * Fold each message that continues a quiet run into the entry before it.
 *
 * An agent that reads one file per turn produces a run of messages that hold a
 * single Read each and no text. Collapsing inside each message would leave that
 * run untouched, so the fold happens on the timeline: a message that continues
 * a run joins the entry before it when that entry's last call is quiet too. The merged entry
 * keeps the first message's id, so it holds its place in the virtual transcript
 * as the run grows.
 *
 * The merged entry carries every member's thoughts in its `reasoningContent`: the
 * compact transcript hides them ({@link hidesThoughtsInCompact}), except while a
 * permission prompt waits on one of the run's calls.
 *
 * Merged entries are cached by the identity of the messages they were built
 * from, so a run that did not change keeps the same object and its row is not
 * re-rendered on every streamed delta elsewhere in the transcript.
 */
export function createQuietCollapser(): <T extends TimelineEntry>(
  timeline: readonly T[],
  context: QuietToolContext,
) => CollapsedTimeline<T> {
  let cache = new Map<string, { members: readonly Message[]; merged: Message }>();
  return <T extends TimelineEntry>(
    timeline: readonly T[],
    context: QuietToolContext,
  ): CollapsedTimeline<T> => {
    const runs: Array<T | Message[]> = [];
    for (const entry of timeline) {
      const previous = runs[runs.length - 1];
      const previousMessage = Array.isArray(previous)
        ? previous[previous.length - 1]
        : isMessage(previous)
          ? previous
          : undefined;
      if (
        isMessage(entry) &&
        previousMessage &&
        continuesQuietRun(entry, context) &&
        endsWithQuietCall(previousMessage, context)
      ) {
        if (Array.isArray(previous)) previous.push(entry);
        else runs[runs.length - 1] = [previousMessage, entry];
        continue;
      }
      runs.push(entry);
    }

    const nextCache = new Map<string, { members: readonly Message[]; merged: Message }>();
    const sourceIds = new Map<string, readonly string[]>();
    const entries = runs.map((run) => {
      if (!Array.isArray(run)) return run;
      const head = run[0]!;
      const cached = cache.get(head.id);
      const merged =
        cached &&
        cached.members.length === run.length &&
        cached.members.every((member, index) => member === run[index])
          ? cached.merged
          : {
              ...head,
              // The head's own `<think>` parts stay in its content; a later member's
              // content is not carried, so its thoughts join the reasoning instead.
              reasoningContent:
                [head.reasoningContent, ...run.slice(1).flatMap(thoughtsOf)]
                  .filter((value): value is string => Boolean(value))
                  .join('\n\n') || undefined,
              toolCalls: run.flatMap((message) => message.toolCalls ?? []),
              toolResults: run.flatMap((message) => message.toolResults ?? []),
              nestedToolInvocations: run.flatMap((message) => message.nestedToolInvocations ?? []),
            };
      nextCache.set(head.id, { members: run, merged });
      sourceIds.set(
        head.id,
        run.map((message) => message.id),
      );
      return merged as T;
    });
    cache = nextCache;
    return { entries, sourceIds };
  };
}

export interface QuietInvocation {
  call: ToolCall;
  result?: ToolResult;
}

/**
 * Split a message's calls into rows: a run of two or more consecutive quiet
 * calls becomes one group; everything else, a lone quiet call included, stays
 * a row of its own. A one-call summary would say less than the row it replaced.
 */
export function groupQuietInvocations<T extends QuietInvocation>(
  invocations: readonly T[],
  message: Message,
  context: QuietToolContext,
): Array<{ kind: 'single'; index: number } | { kind: 'quiet'; indices: number[] }> {
  const rows: Array<{ kind: 'single'; index: number } | { kind: 'quiet'; indices: number[] }> = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: 'quiet', indices: run });
    else for (const index of run) rows.push({ kind: 'single', index });
    run = [];
  };
  invocations.forEach((invocation, index) => {
    if (isQuietInvocation(invocation.call, invocation.result, message, context)) {
      run.push(index);
    } else {
      flush();
      rows.push({ kind: 'single', index });
    }
  });
  flush();
  return rows;
}

export interface QuietRunSummary {
  title: string;
  target: string;
  metadata: string[];
  running: boolean;
  /** The files the run read, by basename, in the order it first read them. */
  files: string[];
  /** What it searched for: patterns, queries, globs. */
  patterns: string[];
  /** The directories it listed; `.` for the current one. */
  listed: string[];
  /** Lookups that are none of those: a `git status`, a tool named by itself. */
  others: string[];
}

function argString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one row a quiet run collapses to: what was read, then the counts.
 *
 * `Read  config.ts, loader.ts, index.ts      3 files · 2 searches`. The target
 * names what the agent looked at, so the summary still says something; the
 * row truncates it to the column like any other target.
 */
export function summarizeQuietRun(
  invocations: readonly QuietInvocation[],
  context?: QuietToolContext,
): QuietRunSummary {
  const files: string[] = [];
  const patterns: string[] = [];
  const listed: string[] = [];
  let listings = 0;
  const others: string[] = [];
  const addFile = (path: string | undefined) => {
    const shown = path ? basename(path.replace(/\\/g, '/')) : 'file';
    if (!files.includes(shown)) files.push(shown);
  };
  for (const { call } of invocations) {
    const name = canonicalToolName(call.name);
    if (name === 'Bash') {
      // A folded command was classified, so the fallback only covers a call whose
      // arguments changed under the summary; it reads as a lookup.
      const command = call.arguments.command;
      const parts = typeof command === 'string' ? shellPartsFor(context, command) : undefined;
      if (!parts) {
        others.push(name);
        continue;
      }
      for (const part of parts) {
        if (part.kind === 'read') addFile(part.path);
        else if (part.kind === 'search') patterns.push(part.query ?? part.path ?? 'search');
        // A git status or log is a lookup, named by its subcommand rather than `Bash`.
        else if (part.kind === 'lookup') others.push(part.target);
        else {
          listings += 1;
          // A listing that names no path is of the current directory.
          const where = part.path ?? '.';
          if (!listed.includes(where)) listed.push(where);
        }
      }
    } else if (name === 'Read') {
      addFile(argString(call.arguments, 'file_path', 'path', 'filePath'));
    } else if (SEARCH_TOOLS.has(name)) {
      const pattern = argString(call.arguments, 'pattern', 'query', 'glob');
      patterns.push(pattern ?? name.toLowerCase());
    } else {
      others.push(name);
    }
  }

  const title =
    files.length > 0 ? 'Read' : patterns.length > 0 ? 'Search' : listings > 0 ? 'List' : 'Check';
  const target =
    files.length > 0
      ? files.join(', ')
      : patterns.length > 0
        ? patterns.join(', ')
        : listings > 0
          ? listed.join(', ')
          : [...new Set(others)].join(', ');
  const metadata: string[] = [];
  if (files.length > 0) metadata.push(plural(files.length, 'file', 'files'));
  if (patterns.length > 0) metadata.push(plural(patterns.length, 'search', 'searches'));
  if (listings > 0) metadata.push(plural(listings, 'listing', 'listings'));
  if (others.length > 0) metadata.push(plural(others.length, 'lookup', 'lookups'));
  return {
    title,
    target,
    metadata,
    running: invocations.some((invocation) => !invocation.result),
    files,
    patterns,
    listed,
    others: [...new Set(others)],
  };
}

/**
 * A folded run's heading, written as the calls it stands for: `Search(memory), Read(4 files)`.
 * A single file or listing is named; several are counted, and the result row names them.
 */
export function quietRunHeading(summary: QuietRunSummary): string {
  const parts: string[] = [];
  if (summary.patterns.length > 0) parts.push(`Search(${summary.patterns.join(', ')})`);
  if (summary.files.length === 1) parts.push(`Read(${summary.files[0]})`);
  else if (summary.files.length > 1) parts.push(`Read(${summary.files.length} files)`);
  if (summary.listed.length > 0) parts.push(`List(${summary.listed.join(', ')})`);
  if (summary.others.length > 0) parts.push(summary.others.join(', '));
  return parts.join(', ') || summary.title;
}
