import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import { diffPreviewOmittedRows, mutationDiffPreview } from './components/Diff.js';
import {
  getFileMutationDisplaySummary,
  isRenderableFileMutationDiff,
} from './file-mutation-display.js';
import { indentedGrid, transcriptGrid } from './layout.js';
import {
  countNestedToolInvocations,
  indexNestedToolInvocations,
  selectLatestToolId,
} from './tool-traces.js';
import {
  composeResultErrorDetail,
  deriveToolPresentation,
  shouldDefaultExpandTool,
  shouldExpandTool,
  showsErrorMessage,
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
  nestedActivityCount?: number;
}

/**
 * Whether the compact transcript draws a body for one tool row that leaves something out: a
 * diff preview with omitted rows, an output preview with hidden lines, or a failure's collapsed
 * detail with a hint. A row whose body is not drawn hides nothing, and a row in the show-all set
 * hides nothing any more.
 *
 * It takes the values `ToolCallBlock` derives its previews from and calls the same functions,
 * so the footer a row draws and this answer cannot disagree.
 */
export function toolRowHidesContent(input: ToolRowPreviewInput): boolean {
  const { name, args, result, isExpanded, transcriptMode, showAllToolOutput } = input;
  const screenReader = input.screenReader ?? false;
  if (screenReader || !result) return false;

  const blockWidth = indentedGrid(transcriptGrid(input.terminalWidth ?? 80)).content;
  const mutationSummary = getFileMutationDisplaySummary(name, args, result);
  // AgentMessage draws a mutation's row as a child under its group heading.
  const isFileChild = mutationSummary !== undefined;
  const isDiff = isRenderableFileMutationDiff(name, result);

  // The failure's message goes under the row whether or not the row is expanded. It shows its
  // whole self only once the row is both expanded and shown in full.
  const inlineError = showsErrorMessage(result) ? result.structuredError?.message : undefined;
  if (inlineError?.trim() && !(showAllToolOutput && isExpanded)) {
    const presentation = deriveToolPresentation(name, args, result, {
      isPending: input.isPending ?? false,
      nestedActivityCount: input.nestedActivityCount ?? 0,
      unparsedArguments: input.unparsedArguments,
    });
    const detail = composeResultErrorDetail({
      presentation,
      message: inlineError,
      result,
      rowGrid: indentedGrid(transcriptGrid(input.terminalWidth ?? 80)),
      isFileChild,
      expanded: false,
      stdoutShownBelow: isExpanded && Boolean(result.content) && !isDiff,
    });
    if (detail?.hint) return true;
  }

  if (!isExpanded || showAllToolOutput) return false;

  if (isDiff) {
    const createsSingleNewFile =
      mutationSummary?.kind === 'create' && (mutationSummary.fileCount ?? 1) <= 1;
    const { preview, maxRows } = mutationDiffPreview({
      createsSingleNewFile,
      transcriptMode,
      screenReader,
    });
    return (
      diffPreviewOmittedRows(result.content, { terminalWidth: blockWidth, preview, maxRows }) > 0
    );
  }
  if (!result.content) return false;
  return (
    toolOutputDisplay(result.content, {
      success: result.status === 'success',
      showAllToolOutput: false,
      terminalWidth: blockWidth,
      expandHint: '',
    }).hiddenLines > 0
  );
}

export interface ExpandTargetInput {
  /** The messages of the transcript on screen. */
  messages: readonly Message[];
  transcriptMode: TranscriptMode;
  /** The terminal width the transcript is drawn at. */
  terminalWidth: number;
  screenReader?: boolean;
  /** The user's explicit expansions and collapses, by tool id. */
  expansionOverrides: ReadonlyMap<string, boolean>;
  /** Rows already shown in full. */
  showAllToolOutputIds: ReadonlySet<string>;
  /** The row the user clicked. */
  focusedToolId: string | null;
  /** The active (running) tool: `selectExpandedToolId`. */
  automaticToolId: string | null;
}

/**
 * The tool row Ctrl+E acts on, and the one row whose truncated footer names the key.
 *
 * Compact transcript, in order: the active tool; the focused tool while it is not yet shown in
 * full; the newest top-level row whose preview hides content; the latest tool. Showing a row in
 * full takes it out of the third rule, so the next press moves to the next one up. Nested
 * subagent invocations are never the newest truncated row. The detailed transcript keeps the old
 * order, which does not look at previews: Ctrl+E there shows everything.
 */
export function selectExpandTargetId({
  messages,
  transcriptMode,
  terminalWidth,
  screenReader = false,
  expansionOverrides,
  showAllToolOutputIds,
  focusedToolId,
  automaticToolId,
}: ExpandTargetInput): string | null {
  if (automaticToolId) return automaticToolId;
  if (transcriptMode === 'detailed') return focusedToolId ?? selectLatestToolId(messages);
  if (focusedToolId && !showAllToolOutputIds.has(focusedToolId)) return focusedToolId;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const calls = message.toolCalls ?? [];
    const nestedChildren = indexNestedToolInvocations(message.nestedToolInvocations ?? []);
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]!;
      // Shown in full already: Ctrl+E has nothing more to reveal there, even when a click has
      // since folded the row back.
      if (showAllToolOutputIds.has(call.id)) continue;
      const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
      if (!result) continue;
      const hides = toolRowHidesContent({
        name: call.name,
        args: call.arguments,
        result,
        unparsedArguments: call.unparsedArguments,
        isExpanded: shouldExpandTool({
          mode: transcriptMode,
          toolId: call.id,
          automaticToolId,
          defaultExpanded: shouldDefaultExpandTool(call.name, result),
          expansionOverrides,
          screenReader,
        }),
        transcriptMode,
        screenReader,
        terminalWidth,
        showAllToolOutput: false,
        nestedActivityCount: countNestedToolInvocations(nestedChildren, call.id),
      });
      if (hides) return call.id;
    }
  }
  return selectLatestToolId(messages);
}
