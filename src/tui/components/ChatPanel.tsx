import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import type { CompactBoundary } from '../../types/sessions.js';
import type { Message } from '../../types/messages.js';
import type { PermissionResult, PlanApprovalResult } from '../../types/tools.js';
import type { RetryPhase } from '../../types/runtime.js';
import type {
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
} from '../../session/agent-interactions.js';
import { AgentMessage, managedAgentTracesEqualForMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount, useDebugRender } from '../debug.js';
import { useDensity } from '../density.js';
import { mergeAssistantMessages } from './transcript-messages.js';
import { selectExpandedToolId } from '../tool-traces.js';
import type { TranscriptMode } from '../tool-presentation.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';
import { truncateDisplay } from './word-wrap.js';
import { useTranscriptHistoryLoader } from '../transcript-layout.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');
const EMPTY_BOUNDARIES: CompactBoundary[] = [];
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

  useEffect(() => {
    if (timeline.length < previousTimelineLengthRef.current) {
      setHistoryWindowSize(completedWindow);
    }
    previousTimelineLengthRef.current = timeline.length;
  }, [completedWindow, timeline.length]);

  const activeWindowSize = streamingMessageId
    ? getStreamingTimelineWindow(terminalHeight)
    : historyWindowSize;
  const hiddenTimelineEntries = Math.max(0, timeline.length - activeWindowSize);
  const visibleTimeline =
    hiddenTimelineEntries > 0 ? timeline.slice(hiddenTimelineEntries) : timeline;
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
      {visibleTimeline.map((entry, index) => {
        if ('transcriptOrdinal' in entry) {
          return <CompactBoundaryRow key={`boundary-${entry.id}`} terminalWidth={terminalWidth} />;
        }
        const message = entry;
        const previous = visibleTimeline[index - 1];
        if (message.role === 'user') {
          return (
            <Box
              key={message.id}
              flexDirection="column"
              marginTop={index > 0 && density !== 'tight' ? 1 : 0}
            >
              {screenReader ? (
                <ScreenReaderRoleLabel role="user" timestamp={message.timestamp} />
              ) : null}
              <UserMessage
                content={message.content}
                attachments={message.attachments}
                terminalWidth={terminalWidth}
                screenReader={screenReader}
              />
            </Box>
          );
        }

        const isStreaming = message.id === streamingMessageId;
        const next = visibleTimeline[index + 1];
        const nextEntryIsUser = Boolean(next && 'role' in next && next.role === 'user');
        const followsToolCall = Boolean(
          previous &&
          'role' in previous &&
          previous.role === 'assistant' &&
          previous.toolCalls?.length,
        );
        return (
          <Box
            key={message.id}
            flexDirection="column"
            marginTop={
              followsToolCall ||
              (density !== 'tight' && previous && 'role' in previous && previous.role === 'user')
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
              pendingPermission={pendingPermission}
              expandedToolCallId={selectedToolCallId}
              transcriptMode={transcriptMode}
              automaticToolCallId={automaticToolCallId ?? selectedToolCallId}
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
              trimTrailingSpacing={nextEntryIsUser}
            />
          </Box>
        );
      })}
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
    previous.retryAttempt !== next.retryAttempt ||
    previous.retryMax !== next.retryMax ||
    previous.retryCountdownMs !== next.retryCountdownMs
  ) {
    return false;
  }

  if (previous.managedAgentTraces === next.managedAgentTraces) return true;
  return previous.messages.every((message) =>
    managedAgentTracesEqualForMessage(
      message,
      previous.managedAgentTraces,
      next.managedAgentTraces,
    ),
  );
});

interface TimelineCache {
  streamingMessageId?: string | null;
  prefixLength: number;
  prefixLast?: Message;
  boundaries?: CompactBoundary[];
  prefix: Array<Message | CompactBoundary>;
}

function useIncrementalTimeline(
  messages: Message[],
  boundaries: CompactBoundary[],
  streamingMessageId?: string | null,
): Array<Message | CompactBoundary> {
  const cache = useRef<TimelineCache>({ prefixLength: -1, prefix: [] });
  if (!streamingMessageId) return buildTimeline(messages, boundaries, streamingMessageId);
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
  return active.kind === 'agent-notification'
    ? cache.current.prefix
    : [...cache.current.prefix, active];
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
    <Box marginLeft={2} width={Math.max(12, Math.floor(terminalWidth) - 2)}>
      <Text color={theme.success}>✓ </Text>
      <Text color={theme.text}>
        {truncateDisplay('Compact conversation', Math.max(8, Math.floor(terminalWidth) - 6))}
      </Text>
    </Box>
  );
}
