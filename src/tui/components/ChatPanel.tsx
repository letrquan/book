import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import { transcriptGrid } from '../layout.js';
import type { CompactBoundary } from '../../types/sessions.js';
import type { Message } from '../../types/messages.js';
import type { PermissionResult, PlanApprovalResult } from '../../types/tools.js';
import type { RetryPhase } from '../../types/runtime.js';
import type {
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
} from '../../session/agent-interactions.js';
import { AgentMessage, managedAgentTracesEqualForMessage } from './AgentMessage.js';
import { UserMessage, userTurnTextWidth } from './UserMessage.js';
import {
  createQuietCollapser,
  groupQuietInvocations,
  type QuietToolContext,
} from '../quiet-tools.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount, useDebugRender } from '../debug.js';
import { useDensity } from '../density.js';
import { mergeAssistantMessages } from './transcript-messages.js';
import { selectExpandedToolId } from '../tool-traces.js';
import type { TranscriptMode } from '../tool-presentation.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { useTranscriptHistoryLoader, useTranscriptLayoutChange } from '../transcript-layout.js';
import { useVirtualTranscript, VirtualTranscriptRow } from './virtual-transcript.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');
const EMPTY_BOUNDARIES: CompactBoundary[] = [];
const NO_SOURCE_IDS: ReadonlyMap<string, readonly string[]> = new Map();
const STREAMING_TIMELINE_MIN_WINDOW = 16;
const STREAMING_TIMELINE_MAX_WINDOW = 64;
const COMPLETED_TIMELINE_MIN_WINDOW = 80;
const COMPLETED_TIMELINE_MAX_WINDOW = 192;

export function getStreamingTimelineWindow(terminalHeight?: number): number {
  const height = Math.max(8, Math.floor(terminalHeight ?? 40));
  // Keep a small amount of context above the viewport without rendering an
  // entire long transcript on every streamed token.
  return Math.min(
    STREAMING_TIMELINE_MAX_WINDOW,
    Math.max(STREAMING_TIMELINE_MIN_WINDOW, Math.ceil(height * 1.25)),
  );
}

export function getCompletedTimelineWindow(terminalHeight?: number): number {
  const height = Math.max(8, Math.floor(terminalHeight ?? 40));
  return Math.min(
    COMPLETED_TIMELINE_MAX_WINDOW,
    Math.max(COMPLETED_TIMELINE_MIN_WINDOW, Math.ceil(height * 3)),
  );
}

function estimateWrappedRows(content: string, contentWidth: number): number {
  // Wrap against the measure the row is actually rendered at, not the raw
  // terminal width: the virtual transcript sizes its spacers from this count,
  // so estimating against the wrong measure undercounts the wrapped rows.
  if (!content) return 1;
  return (
    content
      .split('\n')
      // Ink wraps on display width, so a CJK or emoji line occupies more columns
      // than it has code units and `.length` would report half its true height.
      .reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / contentWidth)), 0)
  );
}

function estimateToolRows(message: Message, quietTools: QuietToolContext | undefined): number {
  const calls = message.toolCalls ?? [];
  if (!quietTools) return calls.length * 2 + (message.toolResults?.length ?? 0);
  const invocations = calls.map((call) => ({
    call,
    result: message.toolResults?.find((result) => result.toolCallId === call.id),
  }));
  // A folded run of quiet calls draws one summary row.
  return groupQuietInvocations(invocations, message, quietTools).reduce(
    (rows, row) => rows + (row.kind === 'quiet' ? 1 : 2 + (invocations[row.index]!.result ? 1 : 0)),
    0,
  );
}

function estimateTimelineRows(
  entry: Message | CompactBoundary,
  terminalWidth: number,
  quietTools?: QuietToolContext,
): number {
  if ('transcriptOrdinal' in entry) return 1;

  // A user turn is its prompt and nothing else: it wraps at its own measure, and
  // there is no separate rule row above it.
  const measure =
    entry.role === 'user'
      ? userTurnTextWidth(terminalWidth, Boolean(entry.timestamp))
      : transcriptGrid(terminalWidth).content;
  const textRows = estimateWrappedRows(entry.content, measure);
  const attachmentRows = entry.attachments?.length ? 1 : 0;
  const toolRows = estimateToolRows(entry, quietTools);
  return Math.max(1, textRows + attachmentRows + toolRows);
}

function messageOwnsTool(message: Message, toolId: string | null | undefined): boolean {
  if (!toolId) return false;
  if (message.toolCalls?.some((call) => call.id === toolId)) return true;
  return Boolean(
    message.nestedToolInvocations?.some(
      (invocation) => invocation.traceId === toolId || invocation.call.id === toolId,
    ),
  );
}

function formatTurnTime(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ScreenReaderRoleLabel({
  role,
  timestamp,
}: {
  role: 'user' | 'assistant';
  timestamp: number;
}) {
  const label = formatTurnTime(timestamp);
  return (
    <Box>
      <Text>
        {role === 'user' ? 'User' : 'Assistant'}
        {label ? ` at ${label}` : ''}
      </Text>
    </Box>
  );
}

interface ChatPanelProps {
  messages: Message[];
  managedAgentTraces?: ReadonlyMap<string, ManagedAgentTrace>;
  compactBoundaries?: CompactBoundary[];
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermissionRequest | null;
  /** @deprecated Approval actions now render in App's fixed interaction area. */
  onResolvePermission?: (result: PermissionResult) => void;
  /** @deprecated Plan details/actions now render outside ChatPanel. */
  pendingPlanApproval?: PendingPlanApprovalRequest | null;
  /** @deprecated Plan details/actions now render outside ChatPanel. */
  onResolvePlanApproval?: (result: PlanApprovalResult) => void;
  /** @deprecated Dynamic transcript rendering no longer needs Static replay epochs. */
  staticEpoch?: number;
  expandedToolCallId?: string | null;
  transcriptMode?: TranscriptMode;
  automaticToolCallId?: string | null;
  toolExpansionOverrides?: ReadonlyMap<string, boolean>;
  reducedMotion?: boolean;
  screenReader?: boolean;
  terminalWidth?: number;
  terminalHeight?: number;
  workspace?: string;
  model?: string;
  mode?: string;
  commandCount?: number;
  skillCount?: number;
  retryPhase?: RetryPhase;
  showAllToolOutput?: boolean;
  showAllToolOutputIds?: ReadonlySet<string>;
  showThinking?: boolean;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/** Dynamically renders transcript content. TranscriptView owns clipping and navigation. */
export function ChatPanelInner({
  messages,
  managedAgentTraces,
  compactBoundaries = EMPTY_BOUNDARIES,
  streamingMessageId,
  pendingPermission,
  expandedToolCallId,
  transcriptMode = 'compact',
  automaticToolCallId,
  toolExpansionOverrides,
  reducedMotion = false,
  screenReader = false,
  terminalWidth,
  terminalHeight,
  workspace,
  model,
  mode,
  commandCount = 0,
  skillCount = 0,
  retryPhase = 'none',
  showAllToolOutput = false,
  showAllToolOutputIds,
  showThinking = true,
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  const density = useDensity();
  useDebugMount(uiLog, { model, mode, commandCount, skillCount });
  const timeline = useIncrementalTimeline(messages, compactBoundaries, streamingMessageId);
  const completedWindow = getCompletedTimelineWindow(terminalHeight);
  const [historyWindowSize, setHistoryWindowSize] = useState(completedWindow);
  const previousTimelineLengthRef = useRef(timeline.length);
  const notifyLayoutChange = useTranscriptLayoutChange();

  useEffect(() => {
    if (timeline.length < previousTimelineLengthRef.current) {
      setHistoryWindowSize(completedWindow);
    }
    previousTimelineLengthRef.current = timeline.length;
  }, [completedWindow, timeline.length]);

  useLayoutEffect(() => {
    notifyLayoutChange?.();
  }, [historyWindowSize, notifyLayoutChange]);

  const activeWindowSize = streamingMessageId
    ? getStreamingTimelineWindow(terminalHeight)
    : historyWindowSize;
  const hiddenTimelineEntries = Math.max(0, timeline.length - activeWindowSize);
  const windowedTimeline = useMemo(
    () => (hiddenTimelineEntries > 0 ? timeline.slice(hiddenTimelineEntries) : timeline),
    [hiddenTimelineEntries, timeline],
  );
  // The compact transcript folds runs of quiet tool calls (reads, searches,
  // lookups) into one summary row, across consecutive messages as well as
  // within one. The fold happens here, on the data, so the virtual transcript
  // sizes one entry per drawn row instead of hiding merged entries (each would
  // still count as a row). Ctrl+O's detailed transcript and screen readers see
  // every call.
  const quietCollapserRef = useRef<ReturnType<typeof createQuietCollapser> | null>(null);
  quietCollapserRef.current ??= createQuietCollapser();
  const pendingToolId = pendingPermission?.toolCall.id;
  const quietTools = useMemo<QuietToolContext | undefined>(() => {
    if (transcriptMode !== 'compact' || screenReader) return undefined;
    // What the user singled out keeps its own row.
    const pinned = new Set<string>();
    for (const [id, expanded] of toolExpansionOverrides ?? []) if (expanded) pinned.add(id);
    if (expandedToolCallId) pinned.add(expandedToolCallId);
    return { pinned, pendingToolId, workspace };
  }, [
    expandedToolCallId,
    pendingToolId,
    screenReader,
    toolExpansionOverrides,
    transcriptMode,
    workspace,
  ]);
  const displayTimeline = useMemo(
    () =>
      quietTools
        ? quietCollapserRef.current!(windowedTimeline, quietTools, showThinking)
        : { entries: windowedTimeline, sourceIds: NO_SOURCE_IDS },
    [quietTools, showThinking, windowedTimeline],
  );
  const visibleTimeline = displayTimeline.entries;
  const getTimelineKey = useCallback(
    (entry: Message | CompactBoundary) =>
      'transcriptOrdinal' in entry ? `boundary-${entry.id}` : entry.id,
    [],
  );
  const estimateRows = useCallback(
    (entry: Message | CompactBoundary) =>
      estimateTimelineRows(entry, terminalWidth ?? 80, quietTools),
    [quietTools, terminalWidth],
  );
  const hiddenHistoryRows = hiddenTimelineEntries > 0 ? (density === 'tight' ? 1 : 2) : 0;
  const virtualTimeline = useVirtualTranscript({
    items: visibleTimeline,
    // Keep completed history virtualized while a live response streams. The
    // active message remains in the virtual range and follows the bottom when
    // the user is not browsing history.
    enabled: !screenReader && visibleTimeline.length > 24,
    terminalWidth: terminalWidth ?? 80,
    leadingRows: hiddenHistoryRows,
    getKey: getTimelineKey,
    estimateRows,
  });
  const estimatedLayoutRows = virtualTimeline.estimatedTotalRows;
  useEffect(() => {
    // Re-measure only when the estimated row count changes. MarkdownBlock and
    // virtual rows also notify for content whose measured height differs from
    // this inexpensive estimate.
    notifyLayoutChange?.();
  }, [estimatedLayoutRows, notifyLayoutChange]);
  const loadOlderHistory = useCallback(
    (request: 'page' | 'all') => {
      if (streamingMessageId || hiddenTimelineEntries === 0) return false;
      setHistoryWindowSize((current) =>
        request === 'all' ? timeline.length : Math.min(timeline.length, current + completedWindow),
      );
      return true;
    },
    [completedWindow, hiddenTimelineEntries, streamingMessageId, timeline.length],
  );
  useTranscriptHistoryLoader(loadOlderHistory);
  const selectedToolCallId =
    expandedToolCallId === undefined ? selectExpandedToolId(messages) : expandedToolCallId;

  useDebugRender(renderLog, {
    total: timeline.length,
    active: streamingMessageId?.slice(-8) ?? null,
    isEmpty: timeline.length === 0,
  });

  if (timeline.length === 0) {
    // A managed child transcript must never fall back to the main welcome
    // banner; callers render their own empty/waiting state around this panel.
    if (mode === 'managed') return null;
    return (
      <WelcomeScreen
        terminalWidth={terminalWidth ?? 80}
        terminalHeight={terminalHeight ?? 24}
        workspace={workspace}
        model={model}
        mode={mode}
        commandCount={commandCount}
        skillCount={skillCount}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
        animate={false}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {hiddenTimelineEntries > 0 ? (
        <Box marginLeft={2} marginBottom={density === 'tight' ? 0 : 1}>
          <Text dimColor>
            {hiddenTimelineEntries} older transcript entries hidden
            {streamingMessageId ? ' while streaming' : ' · scroll to the top to load more'}
          </Text>
        </Box>
      ) : null}
      {virtualTimeline.topSpacerRows > 0 ? (
        <Box height={virtualTimeline.topSpacerRows} flexShrink={0} />
      ) : null}
      {virtualTimeline.entries.map(({ item: entry, index, key, measurementKey }) => {
        let row: React.ReactNode;
        if ('transcriptOrdinal' in entry) {
          row = <CompactBoundaryRow terminalWidth={terminalWidth} />;
        } else {
          const message = entry;
          const previous = visibleTimeline[index - 1];
          if (message.role === 'user') {
            row = (
              <Box flexDirection="column" marginTop={index > 0 && density !== 'tight' ? 1 : 0}>
                {screenReader ? (
                  <ScreenReaderRoleLabel role="user" timestamp={message.timestamp} />
                ) : null}
                <UserMessage
                  content={message.content}
                  attachments={message.attachments}
                  terminalWidth={terminalWidth}
                  timestamp={message.timestamp}
                  screenReader={screenReader}
                />
              </Box>
            );
          } else {
            // A merged entry keeps its first message's id; it is live while any
            // message folded into it is.
            const isStreaming =
              message.id === streamingMessageId ||
              Boolean(
                streamingMessageId &&
                displayTimeline.sourceIds.get(message.id)?.includes(streamingMessageId),
              );
            const rowExpandedToolCallId = messageOwnsTool(message, selectedToolCallId)
              ? selectedToolCallId
              : undefined;
            const rowAutomaticToolCallId = messageOwnsTool(message, automaticToolCallId)
              ? automaticToolCallId
              : undefined;
            const rowPendingPermission =
              pendingPermission && messageOwnsTool(message, pendingPermission.toolCall.id)
                ? pendingPermission
                : undefined;
            const next = visibleTimeline[index + 1];
            const nextEntryIsUser = Boolean(next && 'role' in next && next.role === 'user');
            const followsToolCall = Boolean(
              previous &&
              'role' in previous &&
              previous.role === 'assistant' &&
              previous.toolCalls?.length,
            );
            row = (
              <Box
                flexDirection="column"
                marginTop={
                  followsToolCall ||
                  (density !== 'tight' &&
                    previous &&
                    'role' in previous &&
                    previous.role === 'user')
                    ? 1
                    : 0
                }
              >
                {screenReader ? (
                  <ScreenReaderRoleLabel role="assistant" timestamp={message.timestamp} />
                ) : null}
                <AgentMessage
                  message={message}
                  managedAgentTraces={managedAgentTraces}
                  isStreaming={isStreaming}
                  pendingPermission={rowPendingPermission}
                  expandedToolCallId={rowExpandedToolCallId}
                  transcriptMode={transcriptMode}
                  automaticToolCallId={rowAutomaticToolCallId}
                  toolExpansionOverrides={toolExpansionOverrides}
                  reducedMotion={reducedMotion}
                  screenReader={screenReader}
                  terminalWidth={terminalWidth}
                  retryPhase={isStreaming ? retryPhase : 'none'}
                  retryAttempt={isStreaming ? retryAttempt : 0}
                  retryMax={isStreaming ? retryMax : 0}
                  retryCountdownMs={isStreaming ? retryCountdownMs : 0}
                  hideStreamingSpinner={isStreaming}
                  showAllToolOutput={showAllToolOutput}
                  showAllToolOutputIds={showAllToolOutputIds}
                  showThinking={showThinking}
                  trimTrailingSpacing={nextEntryIsUser}
                  quietTools={quietTools}
                />
              </Box>
            );
          }
        }

        if (!virtualTimeline.virtualized) {
          return <React.Fragment key={key}>{row}</React.Fragment>;
        }
        return (
          <VirtualTranscriptRow
            key={key}
            measurementKey={measurementKey}
            onMeasure={virtualTimeline.measure}
          >
            {row}
          </VirtualTranscriptRow>
        );
      })}
      {virtualTimeline.bottomSpacerRows > 0 ? (
        <Box height={virtualTimeline.bottomSpacerRows} flexShrink={0} />
      ) : null}
    </Box>
  );
}

export const ChatPanel = React.memo(ChatPanelInner, (previous, next) => {
  if (
    previous.messages !== next.messages ||
    previous.compactBoundaries !== next.compactBoundaries ||
    previous.streamingMessageId !== next.streamingMessageId ||
    previous.pendingPermission !== next.pendingPermission ||
    previous.expandedToolCallId !== next.expandedToolCallId ||
    previous.transcriptMode !== next.transcriptMode ||
    previous.automaticToolCallId !== next.automaticToolCallId ||
    previous.toolExpansionOverrides !== next.toolExpansionOverrides ||
    previous.reducedMotion !== next.reducedMotion ||
    previous.screenReader !== next.screenReader ||
    previous.terminalWidth !== next.terminalWidth ||
    previous.terminalHeight !== next.terminalHeight ||
    previous.workspace !== next.workspace ||
    previous.model !== next.model ||
    previous.mode !== next.mode ||
    previous.commandCount !== next.commandCount ||
    previous.skillCount !== next.skillCount ||
    previous.retryPhase !== next.retryPhase ||
    previous.showAllToolOutput !== next.showAllToolOutput ||
    previous.showAllToolOutputIds !== next.showAllToolOutputIds ||
    previous.showThinking !== next.showThinking ||
    previous.retryAttempt !== next.retryAttempt ||
    previous.retryMax !== next.retryMax ||
    previous.retryCountdownMs !== next.retryCountdownMs
  ) {
    return false;
  }

  if (previous.managedAgentTraces === next.managedAgentTraces) return true;
  if (!previous.managedAgentTraces?.size && !next.managedAgentTraces?.size) return true;
  return previous.messages.every((message) =>
    managedAgentTracesEqualForMessage(
      message,
      previous.managedAgentTraces,
      next.managedAgentTraces,
    ),
  );
});

interface TimelineCache {
  messages?: Message[];
  streamingMessageId?: string | null;
  prefixLength: number;
  prefixLast?: Message;
  boundaries?: CompactBoundary[];
  prefix: Array<Message | CompactBoundary>;
  composed?: Array<Message | CompactBoundary>;
  composedActive?: Message;
}

function useIncrementalTimeline(
  messages: Message[],
  boundaries: CompactBoundary[],
  streamingMessageId?: string | null,
): Array<Message | CompactBoundary> {
  const cache = useRef<TimelineCache>({ prefixLength: -1, prefix: [] });
  if (!streamingMessageId) {
    if (cache.current.messages !== messages || cache.current.boundaries !== boundaries) {
      cache.current = {
        messages,
        streamingMessageId,
        prefixLength: messages.length,
        prefixLast: messages.at(-1),
        boundaries,
        prefix: buildTimeline(messages, boundaries, streamingMessageId),
      };
    }
    return cache.current.prefix;
  }
  const streamingIndex = messages.findIndex((message) => message.id === streamingMessageId);
  if (streamingIndex < 0 || streamingIndex !== messages.length - 1) {
    return buildTimeline(messages, boundaries, streamingMessageId);
  }

  const prefixLast = streamingIndex > 0 ? messages[streamingIndex - 1] : undefined;
  if (
    cache.current.streamingMessageId !== streamingMessageId ||
    cache.current.prefixLength !== streamingIndex ||
    cache.current.prefixLast !== prefixLast ||
    cache.current.boundaries !== boundaries
  ) {
    cache.current = {
      streamingMessageId,
      prefixLength: streamingIndex,
      prefixLast,
      boundaries,
      prefix: buildTimeline(messages.slice(0, streamingIndex), boundaries, streamingMessageId),
    };
  }
  const active = messages[streamingIndex];
  if (active.kind === 'agent-notification') return cache.current.prefix;
  // Reuse the composed array while the active message object is unchanged so
  // re-renders without new deltas keep a stable timeline identity downstream.
  if (cache.current.composedActive !== active) {
    cache.current.composed = [...cache.current.prefix, active];
    cache.current.composedActive = active;
  }
  return cache.current.composed!;
}

function buildTimeline(
  messages: Message[],
  boundaries: CompactBoundary[],
  streamingMessageId?: string | null,
): Array<Message | CompactBoundary> {
  const byOrdinal = new Map<number, CompactBoundary[]>();
  for (const boundary of boundaries) {
    const group = byOrdinal.get(boundary.transcriptOrdinal) ?? [];
    group.push(boundary);
    byOrdinal.set(boundary.transcriptOrdinal, group);
  }
  const timeline: Array<Message | CompactBoundary> = [];
  let segment: Message[] = [];
  const flush = () => {
    if (!segment.length) return;
    timeline.push(...mergeAssistantMessages(segment, streamingMessageId));
    segment = [];
  };
  for (let index = 0; index <= messages.length; index++) {
    const markers = byOrdinal.get(index);
    if (markers?.length) {
      flush();
      timeline.push(...markers.sort((a, b) => a.timestamp - b.timestamp));
    }
    if (index < messages.length && messages[index].kind !== 'agent-notification') {
      segment.push(messages[index]);
    }
  }
  flush();
  return timeline;
}

function CompactBoundaryRow({ terminalWidth = 80 }: { terminalWidth?: number }) {
  const theme = useTheme();
  return (
    <Box width={transcriptGrid(terminalWidth).width}>
      <Text color={theme.success}>✓ </Text>
      <Text color={theme.text}>
        {truncateDisplay('Compact conversation', transcriptGrid(terminalWidth).content)}
      </Text>
    </Box>
  );
}
