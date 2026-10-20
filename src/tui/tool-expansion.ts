import type { Message } from '../types/messages.js';
import type { NestedToolInvocation, ToolCall, ToolResult } from '../types/tools.js';
import { diffPreviewOmittedRows, mutationDiffPreview } from './components/Diff.js';
import { getCompletedTimelineWindow } from './components/ChatPanel.js';
import {
  getFileMutationDisplaySummary,
  isRenderableFileMutationDiff,
} from './file-mutation-display.js';
import { canonicalToolName } from '../tools/aliases.js';
import type { MemoryRootDisplay } from './memory-root.js';
import {
  countNestedToolInvocations,
  indexNestedToolInvocations,
  selectLatestToolId,
  type NestedToolChildren,
} from './tool-traces.js';
import {
  commandOutputPreview,
  composeResultErrorDetail,
  deriveToolPresentation,
  exitCodeMetadata,
  isCommandTool,
  labelFailure,
  mutationDiffPreviewInput,
  shouldDefaultExpandTool,
  shouldExpandTool,
  showsErrorMessage,
  toolItemGrids,
  toolOutputDisplay,
  type TranscriptMode,
} from './tool-presentation.js';

/** What `ToolCallBlock` is given for one row, as far as the preview it draws depends on it. */
export interface ToolRowPreviewInput {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  unparsedArguments?: { raw: string; error: string };
  /** What `shouldExpandTool` says for the row: whether its body is drawn at all. */
  isExpanded: boolean;
  transcriptMode: TranscriptMode;
  screenReader?: boolean;
  /** The terminal width the row receives, outer indentation included (80 when it gets none). */
  terminalWidth?: number;
  /** The row is shown in full: it is in the transcript's show-all set. */
  showAllToolOutput: boolean;
  isPending?: boolean;
  /** A count, or a function that makes it: only a failure's detail needs it, so it is lazy. */
  nestedActivityCount?: number | (() => number);
  /** Where the memory directory is: the failure detail names the row's target as the row does. */
  memoryRoot?: MemoryRootDisplay;
}

/**
 * Whether the compact transcript draws a body for one tool row that leaves something out: a
 * diff preview with omitted rows, an output preview with hidden lines, or a failure's collapsed
 * detail with a hint (the lines its tail cut, the stdout a stderr message leaves out, or both). A
 * row whose body is not drawn hides nothing, and a row in the show-all set hides nothing any more.
 *
 * It takes the values `ToolCallBlock` derives its previews from and calls the same functions,
 * so the footer a row draws and this answer cannot disagree.
 */
export function toolRowHidesContent(input: ToolRowPreviewInput): boolean {
  const { name, args, result, isExpanded, transcriptMode, showAllToolOutput } = input;
  const screenReader = input.screenReader ?? false;
  if (screenReader || !result) return false;

  const resultGrid = toolItemGrids(input.terminalWidth ?? 80).result;
  const blockWidth = resultGrid.content;
  const mutationSummary = getFileMutationDisplaySummary(name, args, result);
  const isDiff = isRenderableFileMutationDiff(name, result);

  // The failure's message goes under the row whether or not the row is expanded. It shows its
  // whole self only once the row is both expanded and shown in full.
  const inlineError = showsErrorMessage(result) ? result.structuredError?.message : undefined;
  if (inlineError?.trim() && !(showAllToolOutput && isExpanded)) {
    const { nestedActivityCount = 0 } = input;
    const presentation = deriveToolPresentation(name, args, result, {
      isPending: input.isPending ?? false,
      nestedActivityCount:
        typeof nestedActivityCount === 'function' ? nestedActivityCount() : nestedActivityCount,
      unparsedArguments: input.unparsedArguments,
      memoryRoot: input.memoryRoot,
    });
    // The row opens a sentence of a failure on what kind of stop it was, and a command's on its
    // exit code, as ToolCallBlock draws it.
    const exitCode = exitCodeMetadata(presentation.metadata) !== undefined;
    const detail = composeResultErrorDetail({
      presentation: { title: '', target: undefined },
      message: exitCode ? inlineError : labelFailure(inlineError, presentation.status),
      result,
      rowGrid: resultGrid,
      isFileChild: false,
      expanded: false,
      stdoutShownBelow: isExpanded && Boolean(result.content) && !isDiff,
    });
    if (detail?.hint) return true;
  }

  // A closed command row previews its output's first lines, and says how many it left out.
  if (!isExpanded && result.status === 'success' && isCommandTool(canonicalToolName(name))) {
    return commandOutputPreview(result.content ?? '', blockWidth).hiddenLines > 0;
  }

  if (!isExpanded || showAllToolOutput) return false;

  if (isDiff) {
    const { preview, maxRows, contextRows } = mutationDiffPreview(
      mutationDiffPreviewInput(mutationSummary, { transcriptMode, screenReader }),
    );
    return (
      diffPreviewOmittedRows(result.content, {
        terminalWidth: blockWidth,
        preview,
        maxRows,
        contextRows,
      }) > 0
    );
  }
  if (!result.content) return false;
  // Ctrl+E also reveals the rest of a shortened line: shown in full, a long line wraps.
  const preview = toolOutputDisplay(result.content, {
    success: result.status === 'success',
    showAllToolOutput: false,
    terminalWidth: blockWidth,
    expandHint: '',
  });
  return preview.hiddenLines > 0 || preview.truncatedLines > 0;
}

export interface ExpandTargetInput {
  /** The messages of the transcript on screen. */
  messages: readonly Message[];
  transcriptMode: TranscriptMode;
  /** The terminal width the transcript is drawn at. */
  terminalWidth: number;
  /**
   * The terminal height. ChatPanel draws only the newest `getCompletedTimelineWindow` entries,
   * so the target is looked for in no more messages than that.
   */
  terminalHeight: number;
  screenReader?: boolean;
  /** The user's explicit expansions and collapses, by tool id. */
  expansionOverrides: ReadonlyMap<string, boolean>;
  /** Rows already shown in full. */
  showAllToolOutputIds: ReadonlySet<string>;
  /** The row the user clicked. */
  focusedToolId: string | null;
  /** The active (running) tool: `selectExpandedToolId`. */
  automaticToolId: string | null;
  /**
   * A turn is in progress. A tool call without a result is only active then; an aborted turn
   * leaves one behind, and it must not take the target for the rest of the session.
   */
  running: boolean;
  /** Where the memory directory is, for the target a failed row's detail is composed against. */
  memoryRoot?: MemoryRootDisplay;
}

/**
 * `toolRowHidesContent` answers, by result object and then by the inputs that change the answer.
 *
 * The answer also depends on the call's name and arguments, which belong to the call that owns the
 * result and never change, and on a failure's nested-activity count, which the footer's hint does
 * not depend on. The result object is the identity: `appendToolResultToMessage` and
 * `appendNestedToolInvocationToMessage` (hooks/streaming-state.ts) replace a result with a new
 * object when it changes and never mutate one, so a cached answer cannot go stale. The selector
 * runs on every streamed batch; this keeps it from re-parsing the diffs and outputs of rows that
 * did not change.
 */
const hidesContentCache = new WeakMap<ToolResult, Map<string, boolean>>();

function cachedToolRowHidesContent(input: ToolRowPreviewInput & { result: ToolResult }): boolean {
  const key = [
    input.terminalWidth ?? 80,
    input.transcriptMode,
    input.screenReader ? 1 : 0,
    input.isExpanded ? 1 : 0,
    input.showAllToolOutput ? 1 : 0,
    input.memoryRoot?.roots.join(';') ?? '',
  ].join('|');
  let answers = hidesContentCache.get(input.result);
  if (!answers) {
    answers = new Map();
    hidesContentCache.set(input.result, answers);
  }
  let hides = answers.get(key);
  if (hides === undefined) {
    hides = toolRowHidesContent(input);
    answers.set(key, hides);
  }
  return hides;
}

/** Columns a nested row gives up to its indentation, per level (AgentMessage's NestedToolRows). */
const NESTED_INDENT = 2;
const NESTED_MIN_WIDTH = 12;

/**
 * The tool row Ctrl+E acts on, and the one row whose truncated footer names the key.
 *
 * Compact transcript, in order: the running tool, while a turn is in progress; the focused tool
 * while it still hides content; the newest top-level row whose preview hides content; the latest
 * tool. Showing a row in full takes it out of the third rule, so the next press moves to the
 * next one up. Nested subagent invocations are never the newest truncated row. The detailed
 * transcript keeps the old order, which does not look at previews: Ctrl+E there shows everything.
 *
 * The preview rules look only at the newest `getCompletedTimelineWindow(terminalHeight)`
 * messages: those are the rows ChatPanel draws, so a footer that names the key is always on screen.
 */
export function selectExpandTargetId({
  messages,
  transcriptMode,
  terminalWidth,
  terminalHeight,
  screenReader = false,
  expansionOverrides,
  showAllToolOutputIds,
  focusedToolId,
  automaticToolId,
  running,
  memoryRoot,
}: ExpandTargetInput): string | null {
  if (running && automaticToolId) return automaticToolId;
  if (transcriptMode === 'detailed') return focusedToolId ?? selectLatestToolId(messages);

  const firstVisible = Math.max(0, messages.length - getCompletedTimelineWindow(terminalHeight));

  const hidesContent = (
    call: ToolCall,
    result: ToolResult | undefined,
    width: number,
    nestedActivityCount: () => number,
  ): boolean =>
    result !== undefined &&
    cachedToolRowHidesContent({
      name: call.name,
      args: call.arguments,
      result,
      unparsedArguments: call.unparsedArguments,
      isExpanded: shouldExpandTool({
        mode: transcriptMode,
        toolId: call.id,
        automaticToolId: null,
        defaultExpanded: shouldDefaultExpandTool(call.name, result),
        expansionOverrides,
        screenReader,
      }),
      transcriptMode,
      screenReader,
      terminalWidth: width,
      showAllToolOutput: showAllToolOutputIds.has(call.id),
      nestedActivityCount,
      memoryRoot,
    });

  // The focused row wins only while it still hides content, given how it is drawn now: a click
  // that folded a default-expanded diff back, or a row shown in full, has nothing left to reveal.
  if (focusedToolId) {
    for (let index = messages.length - 1; index >= firstVisible; index--) {
      const message = messages[index]!;
      if (message.role !== 'assistant') continue;
      const call = message.toolCalls?.find((candidate) => candidate.id === focusedToolId);
      if (call) {
        const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
        const countNested = () =>
          countNestedToolInvocations(
            indexNestedToolInvocations(message.nestedToolInvocations ?? []),
            call.id,
          );
        if (hidesContent(call, result, terminalWidth, countNested)) return focusedToolId;
        break;
      }
      const invocation = message.nestedToolInvocations?.find(
        (candidate) => candidate.traceId === focusedToolId,
      );
      if (invocation) {
        const width = Math.max(
          NESTED_MIN_WIDTH,
          terminalWidth - nestedDepth(message.nestedToolInvocations!, invocation) * NESTED_INDENT,
        );
        // Its row is keyed by its trace id, not by its call's id.
        const hides = hidesContent(
          { ...invocation.call, id: invocation.traceId },
          invocation.result,
          width,
          () =>
            countNestedToolInvocations(
              indexNestedToolInvocations(message.nestedToolInvocations ?? []),
              invocation.traceId,
            ),
        );
        if (hides) return focusedToolId;
        break;
      }
    }
  }

  for (let index = messages.length - 1; index >= firstVisible; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) continue;
    const results = new Map(
      (message.toolResults ?? []).map((result) => [result.toolCallId, result]),
    );
    // Built only when a failed row's detail needs a count.
    let nested: NestedToolChildren | undefined;
    const nestedOf = (): NestedToolChildren =>
      (nested ??= indexNestedToolInvocations(message.nestedToolInvocations ?? []));
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]!;
      // Shown in full already: Ctrl+E has nothing more to reveal there, even when a click has
      // since folded the row back.
      if (showAllToolOutputIds.has(call.id)) continue;
      const result = results.get(call.id);
      const countNested = () => countNestedToolInvocations(nestedOf(), call.id);
      if (hidesContent(call, result, terminalWidth, countNested)) {
        return call.id;
      }
    }
  }
  return selectLatestToolId(messages);
}

/** How many levels below a top-level row an invocation sits: a direct child is 1. */
function nestedDepth(
  invocations: readonly NestedToolInvocation[],
  invocation: NestedToolInvocation,
): number {
  const byTraceId = new Map(invocations.map((candidate) => [candidate.traceId, candidate]));
  let depth = 1;
  let parent = byTraceId.get(invocation.parentTraceId);
  const seen = new Set([invocation.traceId]);
  while (parent && !seen.has(parent.traceId)) {
    seen.add(parent.traceId);
    depth++;
    parent = byTraceId.get(parent.parentTraceId);
  }
  return depth;
}
