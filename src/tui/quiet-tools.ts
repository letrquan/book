import { basename, isAbsolute, relative, resolve } from 'path';
import { splitReasoningParts } from '../reasoning-tags.js';
import { canonicalToolName } from '../tools/aliases.js';
import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';

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
 * `Bash` is deliberately absent even when a command only reads (`git diff
 * --stat`): a shell command can change anything, and the transcript cannot tell
 * which ones did.
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
}

/** Whether a read or search reaches outside the workspace. */
function reachesOutside(call: ToolCall, workspace: string | undefined): boolean {
  if (!workspace) return false;
  const target = argString(call.arguments, 'file_path', 'path', 'filePath');
  if (!target) return false;
  const rel = relative(resolve(workspace), resolve(workspace, target));
  return rel.startsWith('..') || isAbsolute(rel);
}

function resultFor(message: Message, toolCallId: string): ToolResult | undefined {
  return message.toolResults?.find((result) => result.toolCallId === toolCallId);
}

/**
 * Whether one call may fold into a summary.
 *
 * A running call may: it joins the run and the summary carries the spinner, so
 * the row does not appear and then vanish when the call finishes. A finished
 * call must have succeeded; a failure, a refusal or a cancellation is news.
 */
export function isQuietInvocation(
  call: ToolCall,
  result: ToolResult | undefined,
  message: Message,
  context: QuietToolContext,
): boolean {
  if (!QUIET_TOOLS.has(canonicalToolName(call.name))) return false;
  if (context.pinned.has(call.id) || context.pendingToolId === call.id) return false;
  if (reachesOutside(call, context.workspace)) return false;
  if (message.nestedToolInvocations?.some((nested) => nested.parentTraceId === call.id)) {
    return false;
  }
  return !result || result.status === 'success';
}

/**
 * Whether a message shows any text of its own.
 *
 * Judged the way AgentMessage renders it, not by `content.trim()`: routers that
 * inline reasoning put `<think></think>` in the content of nearly every
 * tool-call turn, and that renders as nothing. Reasoning only counts when the
 * reader has thinking display on.
 */
export function hasVisibleText(message: Message, showThinking: boolean): boolean {
  const parts = splitReasoningParts(message.content ?? '', { concluded: false });
  for (const part of parts) {
    if (part.kind === 'markdown' && part.text.trim()) return true;
    if (part.kind === 'think' && showThinking && part.text.trim()) return true;
  }
  return Boolean(showThinking && message.reasoningContent?.trim());
}

/**
 * An assistant message with no text of its own whose first call is quiet: it
 * continues a run begun before it.
 *
 * Only the first call has to be quiet. Book already folds a tool-only turn with
 * blank content into the turn before it, so the turn that ends a run of reads
 * often carries the edit that follows them, as `[Read, Edit]`. Requiring every
 * call to be quiet would leave that last read stranded on its own row. The
 * message joins whole; the rows it draws still keep the edit apart (see
 * {@link groupQuietInvocations}).
 */
export function continuesQuietRun(
  message: Message,
  context: QuietToolContext,
  showThinking: boolean,
): boolean {
  if (message.role !== 'assistant' || message.localCommand) return false;
  const first = message.toolCalls?.[0];
  if (!first) return false;
  // Joining would put a spawn in the same entry as the narration before it,
  // and AgentMessage hides a delegating entry's narration.
  if (message.toolCalls!.some((call) => call.name === 'AgentSpawn')) return false;
  if (hasVisibleText(message, showThinking)) return false;
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
 * Merged entries are cached by the identity of the messages they were built
 * from, so a run that did not change keeps the same object and its row is not
 * re-rendered on every streamed delta elsewhere in the transcript.
 */
export function createQuietCollapser(): <T extends TimelineEntry>(
  timeline: readonly T[],
  context: QuietToolContext,
  showThinking: boolean,
) => CollapsedTimeline<T> {
  let cache = new Map<string, { members: readonly Message[]; merged: Message }>();
  return <T extends TimelineEntry>(
    timeline: readonly T[],
    context: QuietToolContext,
    showThinking: boolean,
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
        continuesQuietRun(entry, context, showThinking) &&
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
              reasoningContent:
                run
                  .map((message) => message.reasoningContent)
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
export function summarizeQuietRun(invocations: readonly QuietInvocation[]): QuietRunSummary {
  const files: string[] = [];
  const patterns: string[] = [];
  const others: string[] = [];
  for (const { call } of invocations) {
    const name = canonicalToolName(call.name);
    if (name === 'Read') {
      const path = argString(call.arguments, 'file_path', 'path', 'filePath');
      const shown = path ? basename(path.replace(/\\/g, '/')) : 'file';
      if (!files.includes(shown)) files.push(shown);
    } else if (SEARCH_TOOLS.has(name)) {
      const pattern = argString(call.arguments, 'pattern', 'query', 'glob');
      patterns.push(pattern ?? name.toLowerCase());
    } else {
      others.push(name);
    }
  }

  const title = files.length > 0 ? 'Read' : patterns.length > 0 ? 'Search' : 'Check';
  const target =
    files.length > 0
      ? files.join(', ')
      : patterns.length > 0
        ? patterns.join(', ')
        : [...new Set(others)].join(', ');
  const metadata: string[] = [];
  if (files.length > 0) metadata.push(plural(files.length, 'file', 'files'));
  if (patterns.length > 0) metadata.push(plural(patterns.length, 'search', 'searches'));
  if (others.length > 0) metadata.push(plural(others.length, 'lookup', 'lookups'));
  return {
    title,
    target,
    metadata,
    running: invocations.some((invocation) => !invocation.result),
  };
}
