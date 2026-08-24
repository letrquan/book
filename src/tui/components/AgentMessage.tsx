import { Text, Box } from 'ink';
import React, { useMemo } from 'react';
import { Spinner } from './Spinner.js';
import { MetaText, TargetText, ToolCallBlock } from './ToolCallBlock.js';
import { DiffBlock, isUnifiedDiffLike } from './Diff.js';
import { MarkdownBlock, useThrottledValue } from './MarkdownBlock.js';
import { CommandPanel } from './CommandPanel.js';
import { useTheme } from '../theme.js';
import { useDensityMetrics } from '../density.js';
import { CONTENT_COLUMN, GUTTER_WIDTH, transcriptGrid, withLabelColumn } from '../layout.js';
import { composeToolRow, toolLabelColumnWidth, toolRowLabel } from '../tool-presentation.js';
import type { Message } from '../../types/messages.js';
import type { RetryPhase } from '../../types/runtime.js';
import type { PendingPermissionRequest } from '../../session/agent-interactions.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import {
  countNestedToolInvocations,
  indexNestedToolInvocations,
  type NestedToolChildren,
} from '../tool-traces.js';
import {
  getFileMutationDisplaySummary,
  type FileMutationDisplaySummary,
} from '../file-mutation-display.js';
import {
  shouldDefaultExpandTool,
  shouldExpandTool,
  type TranscriptMode,
} from '../tool-presentation.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';
import { ManagedAgentActivityBlock } from './ManagedAgentActivityBlock.js';
import { useDebugRender } from '../debug.js';

const renderLog = createRenderDebugLogger('tui:agentmsg');

interface AgentMessageProps {
  message: Message;
  managedAgentTraces?: ReadonlyMap<string, ManagedAgentTrace>;
  isStreaming: boolean;
  pendingPermission?: PendingPermissionRequest | null;
  expandedToolCallId?: string | null;
  transcriptMode?: TranscriptMode;
  automaticToolCallId?: string | null;
  toolExpansionOverrides?: ReadonlyMap<string, boolean>;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Terminal width in columns — passed down to MarkdownBlock for word-wrap. */
  terminalWidth?: number;
  /** Retry state — shown in the spinner line when active. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
  /** Hide the inline streaming spinner when an external working indicator owns activity state. */
  hideStreamingSpinner?: boolean;
  /** When true, expanded tool results show the larger output cap instead of a short preview. */
  showAllToolOutput?: boolean;
  /** Tool-specific full-output expansion used by compact transcript mode. */
  showAllToolOutputIds?: ReadonlySet<string>;
  /** Whether provider-native and embedded model thinking should be shown. */
  showThinking?: boolean;
  /** Remove the final markdown block's margin before the next user turn. */
  trimTrailingSpacing?: boolean;
}

const NO_EXPANSION_OVERRIDES = new Map<string, boolean>();
const NO_SHOW_ALL_TOOL_OUTPUT_IDS: ReadonlySet<string> = new Set<string>();
function NestedToolRows({
  childrenByParent,
  parentTraceId,
  depth,
  transcriptMode,
  automaticToolCallId,
  toolExpansionOverrides,
  reducedMotion,
  screenReader,
  showAllToolOutput,
  showAllToolOutputIds,
  terminalWidth,
  toolRowGap,
}: {
  childrenByParent: NestedToolChildren;
  parentTraceId: string;
  depth: number;
  transcriptMode: TranscriptMode;
  automaticToolCallId?: string | null;
  toolExpansionOverrides: ReadonlyMap<string, boolean>;
  reducedMotion: boolean;
  screenReader: boolean;
  showAllToolOutput: boolean;
  showAllToolOutputIds: ReadonlySet<string>;
  terminalWidth?: number;
  toolRowGap: 0 | 1;
}) {
  const children = childrenByParent.get(parentTraceId) ?? [];
  return children.map((invocation) => {
    return (
      <Box
        key={invocation.traceId}
        flexDirection="column"
        marginLeft={screenReader ? 2 : depth * 2}
        marginTop={toolRowGap}
      >
        <ToolCallBlock
          toolId={invocation.traceId}
          name={invocation.call.name}
          args={invocation.call.arguments}
          result={invocation.result}
          isExpanded={shouldExpandTool({
            mode: transcriptMode,
            toolId: invocation.traceId,
            automaticToolId: automaticToolCallId,
            defaultExpanded: shouldDefaultExpandTool(invocation.call.name, invocation.result),
            expansionOverrides: toolExpansionOverrides,
            screenReader,
          })}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
          showAllToolOutput={showAllToolOutput || showAllToolOutputIds.has(invocation.traceId)}
          terminalWidth={terminalWidth ? Math.max(12, terminalWidth - depth * 2) : undefined}
        />
        <NestedToolRows
          childrenByParent={childrenByParent}
          parentTraceId={invocation.traceId}
          depth={depth + 1}
          transcriptMode={transcriptMode}
          automaticToolCallId={automaticToolCallId}
          toolExpansionOverrides={toolExpansionOverrides}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
          showAllToolOutput={showAllToolOutput}
          showAllToolOutputIds={showAllToolOutputIds}
          terminalWidth={terminalWidth}
          toolRowGap={toolRowGap}
        />
      </Box>
    );
  });
}

/**
 * Strip trailing partial markdown code-fence closings from streaming text.
 *
 * While streaming, the LLM may emit incomplete closing fences (e.g. `` after a
 * ```rust block). These partial markers cause rendered code blocks to visually
 * jitter as the fence opens/closes. This function detects when the last line is
 * a non-empty prefix of a closing fence marker and strips it.
 */
export function trimPartialClosingFences(text: string): string {
  const lines = text.split('\n');
  let lastOpenIdx = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^```/.test(lines[i])) {
      lastOpenIdx = i;
      break;
    }
  }

  if (lastOpenIdx === -1) return text;

  let hasClose = false;
  for (let i = lastOpenIdx + 1; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i])) {
      hasClose = true;
      break;
    }
  }

  if (hasClose) return text;

  const lastLine = lines[lines.length - 1];
  if (lastLine === '') return text;

  const closeMarker = '```';
  if (lastLine !== closeMarker && closeMarker.startsWith(lastLine)) {
    return lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '');
  }

  return text;
}

/** Build the spinner label based on retry state. Exported for testing. */
export function getRetryLabel(
  retryPhase: RetryPhase,
  retryAttempt: number,
  retryMax: number,
  retryCountdownMs: number,
): string | undefined {
  if (retryPhase === 'transport') {
    const countdown = Math.max(0, Math.ceil(retryCountdownMs / 1000));
    const attemptStr =
      retryMax > 0 ? `attempt ${retryAttempt}/${retryMax}` : `attempt ${retryAttempt}`;
    return `Retrying in ${countdown}s · ${attemptStr}`;
  }
  if (retryPhase === 'stalled') {
    const countdown = Math.max(0, Math.ceil(retryCountdownMs / 1000));
    return `Waiting for API response · will retry in ${countdown}s · check your network`;
  }
  if (retryPhase === 'watchdog') {
    return `Retrying (watchdog) · attempt ${retryAttempt}`;
  }
  return undefined;
}

interface ThinkBlockPart {
  kind: 'think';
  text: string;
}

interface MarkdownPart {
  kind: 'markdown';
  text: string;
}

type MessagePart = ThinkBlockPart | MarkdownPart;

/**
 * Tags a provider may wrap reasoning in.
 *
 * An unlisted tag is not merely unstyled: `marked` sees raw markup and renders
 * the block as fenced HTML, so the transcript grew a code block labelled `html`
 * containing the model's private reasoning.
 */
const REASONING_TAG_PATTERN =
  /<(think|thinking|reasoning|reasoning_context)>([\s\S]*?)(?:<\/\1>|$)/gi;

export function splitThinkBlocks(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern = REASONING_TAG_PATTERN;
  pattern.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before) parts.push({ kind: 'markdown', text: before });
    parts.push({ kind: 'think', text: match[2].trim() });
    lastIndex = pattern.lastIndex;
  }

  const after = content.slice(lastIndex);
  if (after) parts.push({ kind: 'markdown', text: after });
  return parts.length > 0 ? parts : [{ kind: 'markdown', text: content }];
}

function reasoningLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function countReasoningLines(text: string): number {
  return reasoningLines(text).length;
}

/**
 * Rows a completed thought would occupy if it were expanded.
 *
 * The collapsed row advertises what expanding costs, so it has to count
 * *rendered* rows. Counting source lines put `Thought - 2 lines` above four
 * wrapped rows, which read as a bug in the count rather than a wrap.
 */
export function countReasoningRows(text: string, width?: number): number {
  const lines = reasoningLines(text);
  if (!width || width <= 0) return lines.length;
  const measure = Math.max(8, Math.floor(width));
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / measure)), 0);
}

function ThinkBlock({
  text,
  terminalWidth,
  reducedMotion,
  active = true,
  expanded = false,
  screenReader = false,
}: {
  text: string;
  terminalWidth?: number;
  reducedMotion?: boolean;
  active?: boolean;
  /** Detailed transcript mode keeps a finished thought open. */
  expanded?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  // Keep the complete thought readable while avoiding a terminal redraw for every delta.
  const streamedText = useThrottledValue(text, 80);
  // The body sits two gutters in from the block's own width: the rail plus its
  // padding, then the indent under the header.
  const bodyWidth =
    terminalWidth === undefined || screenReader
      ? terminalWidth
      : Math.max(12, Math.floor(terminalWidth) - GUTTER_WIDTH * 2);
  const rowCount = countReasoningRows(text, bodyWidth);
  const rowLabel = `${rowCount} ${rowCount === 1 ? 'line' : 'lines'}`;

  // A finished thought collapses to one row.
  //
  // Watching reasoning arrive is the point of showing it; re-reading it in
  // scrollback is not. Expanded by default it put the least important content
  // of a turn in the most prominent position — several rows of it above the
  // first sentence of the answer. Detailed mode (Ctrl+O) reopens it, so
  // nothing becomes unreachable.
  if (!active && !expanded && !screenReader) {
    return (
      <Box>
        <Text color={theme.mdThinkText} dimColor>
          {`▸ thought · ${rowLabel}`}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderLeft={!screenReader}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={theme.mdThinkBorder}
      paddingLeft={screenReader ? 0 : 1}
    >
      <Box>
        {active && !screenReader ? (
          <Spinner active color={theme.mdThinkText} reducedMotion={reducedMotion} />
        ) : null}
        <Text color={theme.mdThinkText} bold={active} dimColor={!active}>
          {active ? 'Thinking' : 'Thought'}
        </Text>
        {!active ? <Text color={theme.subtle} dimColor>{` - ${rowLabel}`}</Text> : null}
      </Box>
      <Box marginLeft={screenReader ? 0 : CONTENT_COLUMN}>
        {active ? (
          <Text color={theme.mdThinkText} dimColor>
            {streamedText}
          </Text>
        ) : (
          <MarkdownBlock content={text} terminalWidth={bodyWidth} />
        )}
      </Box>
    </Box>
  );
}

/**
 * Heading for a run of consecutive file mutations, laid out like a tool row so
 * its verb, target and churn land on the same columns as everything else.
 */
function MutationGroupRow({
  createdOnly,
  fileCount,
  addedLines,
  removedLines,
  grid,
  screenReader,
}: {
  createdOnly: boolean;
  fileCount: number;
  addedLines: number;
  removedLines: number;
  grid: ReturnType<typeof transcriptGrid>;
  screenReader: boolean;
}) {
  const theme = useTheme();
  const row = composeToolRow(
    {
      title: createdOnly ? 'Create' : 'Edit',
      target: `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
      metadata: [`+${addedLines}`, `-${removedLines}`],
    },
    grid,
  );
  if (screenReader) {
    return (
      <Box>
        <Text>
          {createdOnly ? 'Created' : 'Edited'} {fileCount} {fileCount === 1 ? 'file' : 'files'} (+
          {addedLines} -{removedLines})
        </Text>
      </Box>
    );
  }
  return (
    <Box height={1}>
      <Text color={theme.success}>{'• '}</Text>
      {row.label ? (
        <Text color={theme.inactive} dimColor>
          {row.label}{' '}
        </Text>
      ) : null}
      <TargetText target={row.target} failed={false} />
      <Text>{row.gap}</Text>
      <MetaText meta={row.meta} failed={false} />
    </Box>
  );
}

/**
 * Marks where reasoning ends and the answer begins.
 *
 * Visually this is a blank row: a finished thought already collapses to a
 * single line, so a labelled rule on top of it was chrome announcing chrome.
 * Screen readers still get the spoken boundary, which they cannot infer from
 * spacing.
 */
function AnswerDivider({ screenReader }: { screenReader: boolean }) {
  if (!screenReader) return <Box marginTop={1} />;
  return (
    <Box>
      <Text>Answer:</Text>
    </Box>
  );
}

/**
 * Claude Code-style agent message block.
 *
 * Each assistant turn renders as:
 *   1. Spinner line — shows thinking tips, or retry countdown during retries
 *   2. Streaming text content
 *   3. One tool row per invocation, with Task subagent tools nested below their parent
 *
 * During retries, the spinner line shows Claude Code-style messages:
 *   - Transport retry: "Retrying in 4s · attempt 3/10"
 *   - Stream stall:    "Waiting for API response · will retry in 8s · check your network"
 *   - Watchdog:        "Retrying (watchdog) · attempt 47"
 *
 * When screenReader mode is enabled, all decorations (spinners,
 * box borders, expand/collapse toggles) are stripped for flat,
 * accessible rendering.
 */
export function AgentMessageInner({
  message,
  managedAgentTraces,
  isStreaming,
  pendingPermission,
  expandedToolCallId,
  transcriptMode = 'compact',
  automaticToolCallId,
  toolExpansionOverrides = NO_EXPANSION_OVERRIDES,
  reducedMotion = false,
  screenReader = false,
  terminalWidth,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
  hideStreamingSpinner = false,
  showAllToolOutput = false,
  showAllToolOutputIds = NO_SHOW_ALL_TOOL_OUTPUT_IDS,
  showThinking = true,
  trimTrailingSpacing = false,
}: AgentMessageProps) {
  const theme = useTheme();
  const { toolRowGap, toolBlockGap } = useDensityMetrics();
  const toolCalls = message.toolCalls ?? [];
  const suppressDelegationNarration = toolCalls.some((call) => {
    if (call.name !== 'AgentSpawn') return false;
    const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
    return !result || result.status === 'success';
  });
  // AgentSpawn has its own activity row. Keep the model text in history/context,
  // but avoid showing duplicated delegation narration in the user transcript.
  const rawDisplayContent = useMemo(
    () => (isStreaming ? trimPartialClosingFences(message.content) : message.content),
    [isStreaming, message.content],
  );
  const displayContent = suppressDelegationNarration ? '' : rawDisplayContent;
  const reasoningContent = message.reasoningContent;

  useDebugRender(renderLog, {
    id: message.id.slice(-8),
    streaming: isStreaming,
    contentLen: displayContent.length,
    toolCalls: (message.toolCalls ?? []).length,
    toolResults: (message.toolResults ?? []).length,
    retry: retryPhase,
  });

  const childrenByParent = useMemo(
    () => indexNestedToolInvocations(message.nestedToolInvocations ?? []),
    [message.nestedToolInvocations],
  );

  const spinnerLabel = useMemo(
    () => getRetryLabel(retryPhase, retryAttempt, retryMax, retryCountdownMs),
    [retryPhase, retryAttempt, retryMax, retryCountdownMs],
  );

  const isRetrying = retryPhase !== 'none';

  // Prose sits on the transcript content column, the same one tool rows and the
  // status line use. Activity labels render on their own row so they never
  // steal horizontal space from markdown or diffs.
  const grid = useMemo(() => transcriptGrid(terminalWidth ?? 80), [terminalWidth]);
  const contentWidth = terminalWidth ? grid.content : undefined;
  const mdWidth = contentWidth;
  const contentParts = useMemo(() => splitThinkBlocks(displayContent), [displayContent]);
  const renderAsUnifiedDiff = useMemo(
    () => displayContent.length > 0 && isUnifiedDiffLike(displayContent),
    [displayContent],
  );
  const embeddedThinking = useMemo(
    () => contentParts.some((part) => part.kind === 'think'),
    [contentParts],
  );
  const topLevelInvocations = useMemo(
    () =>
      toolCalls.map((call) => {
        const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
        return {
          id: call.id,
          name: call.name,
          call,
          result,
          mutation: getFileMutationDisplaySummary(call.name, call.arguments, result),
        };
      }),
    [message.toolResults, toolCalls],
  );
  // Size the label column to this turn's own rows. A turn of `Bash` / `Read`
  // rows padded to fit a hypothetical `Git status` puts seven dead columns
  // between every verb and its target.
  const labelWidth = useMemo(
    () =>
      toolLabelColumnWidth(
        topLevelInvocations.map((invocation) => toolRowLabel(invocation.name, invocation.result)),
      ),
    [topLevelInvocations],
  );
  const mutationGrid = useMemo(() => withLabelColumn(grid, labelWidth), [grid, labelWidth]);
  const selectedAutomaticToolId = automaticToolCallId ?? expandedToolCallId;

  if (message.localCommand) {
    return (
      <CommandPanel
        display={message.localCommand}
        fallback={displayContent}
        terminalWidth={terminalWidth}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {/* Spinner line: shows thinking tips, or retry countdown during retries */}
      {isStreaming &&
      !hideStreamingSpinner &&
      !displayContent &&
      !(showThinking && reasoningContent) &&
      !message.toolCalls?.length ? (
        <Box marginLeft={screenReader ? 0 : CONTENT_COLUMN}>
          {isRetrying && spinnerLabel ? (
            <Box>
              <Text color={theme.error}>Retrying: </Text>
              <Text color={theme.error}>{spinnerLabel}</Text>
            </Box>
          ) : (
            <Spinner active reducedMotion={reducedMotion} showTips={true} />
          )}
        </Box>
      ) : null}

      {showThinking && reasoningContent ? (
        <Box marginLeft={screenReader ? 0 : CONTENT_COLUMN} flexDirection="column">
          <ThinkBlock
            text={reasoningContent}
            terminalWidth={mdWidth}
            reducedMotion={reducedMotion}
            active={isStreaming && !displayContent}
            expanded={transcriptMode === 'detailed'}
            screenReader={screenReader}
          />
        </Box>
      ) : null}

      {/* Activity and content use separate rows so markdown keeps its full budget. */}
      {displayContent ? (
        <Box marginLeft={screenReader ? 0 : CONTENT_COLUMN} flexDirection="column">
          {showThinking && reasoningContent && !embeddedThinking ? (
            <AnswerDivider screenReader={screenReader} />
          ) : null}
          {isStreaming && !hideStreamingSpinner && !isRetrying ? (
            <Box>
              <Spinner active reducedMotion={reducedMotion} />
            </Box>
          ) : null}
          {isRetrying && !hideStreamingSpinner && spinnerLabel ? (
            <Box>
              <Text color={theme.error}>Retrying: </Text>
              <Text color={theme.error}>{spinnerLabel}</Text>
            </Box>
          ) : null}
          {renderAsUnifiedDiff ? (
            <DiffBlock output={displayContent} terminalWidth={contentWidth} />
          ) : (
            <Box flexDirection="column">
              {contentParts.map((part, i) => {
                if (part.kind === 'think') {
                  if (!showThinking) return null;
                  const answerHasStarted = contentParts
                    .slice(i + 1)
                    .some((candidate) => candidate.kind === 'markdown' && candidate.text.trim());
                  return (
                    <ThinkBlock
                      key={`think-${i}`}
                      text={part.text}
                      terminalWidth={mdWidth}
                      reducedMotion={reducedMotion}
                      active={isStreaming && !answerHasStarted}
                      expanded={transcriptMode === 'detailed'}
                      screenReader={screenReader}
                    />
                  );
                }
                const hasEarlierThinking = contentParts
                  .slice(0, i)
                  .some((candidate) => candidate.kind === 'think');
                return (
                  <React.Fragment key={`md-${i}`}>
                    {showThinking && hasEarlierThinking ? (
                      <AnswerDivider screenReader={screenReader} />
                    ) : null}
                    <MarkdownBlock
                      content={part.text}
                      terminalWidth={mdWidth}
                      isStreaming={isStreaming}
                      trimTrailingMargin={trimTrailingSpacing && i === contentParts.length - 1}
                    />
                  </React.Fragment>
                );
              })}
            </Box>
          )}
        </Box>
      ) : null}

      {/* Every invocation gets its own row. Task subagent tools stay display-only and nest below it. */}
      {topLevelInvocations.map((invocation, index) => {
        const marginTop =
          index === 0
            ? displayContent || (showThinking && reasoningContent)
              ? toolBlockGap
              : 0
            : toolRowGap;
        const tc = invocation.call;
        const result = invocation.result;
        const mutation = invocation.mutation;
        const previousMutation = topLevelInvocations[index - 1]?.mutation;
        let mutationGroup:
          | {
              summaries: FileMutationDisplaySummary[];
              fileCount: number;
              addedLines: number;
              removedLines: number;
              createdOnly: boolean;
            }
          | undefined;
        if (mutation && !previousMutation) {
          const summaries: FileMutationDisplaySummary[] = [];
          for (let groupIndex = index; groupIndex < topLevelInvocations.length; groupIndex++) {
            const summary = topLevelInvocations[groupIndex].mutation;
            if (!summary) break;
            summaries.push(summary);
          }
          mutationGroup = {
            summaries,
            fileCount: summaries.some((summary) => (summary.fileCount ?? 1) > 1)
              ? summaries.reduce((total, summary) => total + (summary.fileCount ?? 1), 0)
              : new Set(summaries.map((summary) => summary.filePath)).size,
            addedLines: summaries.reduce((total, summary) => total + summary.addedLines, 0),
            removedLines: summaries.reduce((total, summary) => total + summary.removedLines, 0),
            createdOnly: summaries.every((summary) => summary.kind === 'create'),
          };
        }
        const isPending = pendingPermission?.toolCall.id === tc.id;
        const managedAgentTrace = managedAgentTraces?.get(tc.id);
        return (
          <Box
            key={tc.id || `tool-${index}`}
            flexDirection="column"
            marginTop={mutation && previousMutation ? 0 : marginTop}
          >
            {mutationGroup ? (
              <MutationGroupRow
                createdOnly={mutationGroup.createdOnly}
                fileCount={mutationGroup.fileCount}
                addedLines={mutationGroup.addedLines}
                removedLines={mutationGroup.removedLines}
                grid={mutationGrid}
                screenReader={screenReader}
              />
            ) : null}
            {managedAgentTrace ? (
              <ManagedAgentActivityBlock
                trace={managedAgentTrace}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                terminalWidth={terminalWidth}
              />
            ) : (
              <ToolCallBlock
                toolId={tc.id}
                name={tc.name}
                args={tc.arguments}
                result={result}
                isExpanded={shouldExpandTool({
                  mode: transcriptMode,
                  toolId: tc.id,
                  automaticToolId: selectedAutomaticToolId,
                  defaultExpanded: shouldDefaultExpandTool(tc.name, result),
                  expansionOverrides: toolExpansionOverrides,
                  screenReader,
                })}
                isPending={isPending}
                nestedActivityCount={countNestedToolInvocations(childrenByParent, tc.id)}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                showAllToolOutput={showAllToolOutput || showAllToolOutputIds.has(tc.id)}
                summaryVariant={mutation ? 'file-child' : 'default'}
                terminalWidth={terminalWidth}
                labelWidth={labelWidth}
              />
            )}
            {!managedAgentTrace && childrenByParent.has(tc.id) ? (
              <NestedToolRows
                childrenByParent={childrenByParent}
                parentTraceId={tc.id}
                depth={1}
                transcriptMode={transcriptMode}
                automaticToolCallId={selectedAutomaticToolId}
                toolExpansionOverrides={toolExpansionOverrides}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                showAllToolOutput={showAllToolOutput}
                showAllToolOutputIds={showAllToolOutputIds}
                terminalWidth={terminalWidth}
                toolRowGap={toolRowGap}
              />
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function managedAgentTraceEqual(
  left: ManagedAgentTrace | undefined,
  right: ManagedAgentTrace | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.agentId !== right.agentId ||
    left.parentToolCallId !== right.parentToolCallId ||
    left.profile !== right.profile ||
    left.purpose !== right.purpose ||
    left.status !== right.status ||
    left.startedAt !== right.startedAt ||
    left.finishedAt !== right.finishedAt ||
    left.toolUses.length !== right.toolUses.length
  ) {
    return false;
  }
  return left.toolUses.every((tool, index) => {
    const candidate = right.toolUses[index];
    return (
      candidate !== undefined &&
      tool.id === candidate.id &&
      tool.call === candidate.call &&
      tool.result === candidate.result &&
      tool.status === candidate.status &&
      tool.startedAt === candidate.startedAt &&
      tool.finishedAt === candidate.finishedAt
    );
  });
}

export function managedAgentTracesEqualForMessage(
  message: Message,
  left: ReadonlyMap<string, ManagedAgentTrace> | undefined,
  right: ReadonlyMap<string, ManagedAgentTrace> | undefined,
): boolean {
  if (left === right) return true;
  for (const call of message.toolCalls ?? []) {
    if (call.name !== 'AgentSpawn') continue;
    if (!managedAgentTraceEqual(left?.get(call.id), right?.get(call.id))) return false;
  }
  return true;
}

/**
 * Memoized agent message with a custom comparator.
 *
 * Scalar props are compared first (fast path). Message arrays use reference
 * equality because every streaming append/result update replaces its array.
 *
 */
export const AgentMessage = React.memo(AgentMessageInner, (prev, next) => {
  // Fast path: same references for the most common props.
  if (
    prev.isStreaming === next.isStreaming &&
    prev.expandedToolCallId === next.expandedToolCallId &&
    prev.transcriptMode === next.transcriptMode &&
    prev.automaticToolCallId === next.automaticToolCallId &&
    prev.toolExpansionOverrides === next.toolExpansionOverrides &&
    prev.pendingPermission?.toolCall?.id === next.pendingPermission?.toolCall?.id &&
    prev.retryPhase === next.retryPhase &&
    prev.retryAttempt === next.retryAttempt &&
    prev.retryMax === next.retryMax &&
    prev.retryCountdownMs === next.retryCountdownMs &&
    prev.hideStreamingSpinner === next.hideStreamingSpinner &&
    prev.showAllToolOutput === next.showAllToolOutput &&
    prev.showAllToolOutputIds === next.showAllToolOutputIds &&
    prev.showThinking === next.showThinking &&
    prev.trimTrailingSpacing === next.trimTrailingSpacing &&
    prev.reducedMotion === next.reducedMotion &&
    prev.screenReader === next.screenReader &&
    prev.terminalWidth === next.terminalWidth
  ) {
    // Check message identity.
    const pm = prev.message;
    const nm = next.message;
    if (
      pm.id === nm.id &&
      pm.content === nm.content &&
      pm.reasoningContent === nm.reasoningContent &&
      pm.localCommand === nm.localCommand &&
      pm.toolCalls === nm.toolCalls &&
      pm.toolResults === nm.toolResults &&
      pm.nestedToolInvocations === nm.nestedToolInvocations &&
      managedAgentTracesEqualForMessage(nm, prev.managedAgentTraces, next.managedAgentTraces)
    ) {
      return true; // skip re-render
    }
  }
  return false;
});
