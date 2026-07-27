import { Box, Text } from 'ink';
import { useRef } from 'react';
import { useTheme } from '../theme.js';
import type { CompactBoundary } from '../../types/sessions.js';
import type { Message } from '../../types/messages.js';
import type { PermissionResult, PlanApprovalResult } from '../../types/tools.js';
import type { RetryPhase } from '../../types/runtime.js';
import type {
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
} from '../../session/agent-interactions.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { useDensity } from '../density.js';
import { mergeAssistantMessages } from './transcript-messages.js';
import { selectExpandedToolId } from '../tool-traces.js';
import type { TranscriptMode } from '../tool-presentation.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';
import { truncateDisplay } from './word-wrap.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');
const EMPTY_BOUNDARIES: CompactBoundary[] = [];
const STREAMING_TIMELINE_WINDOW = 64;

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
export function ChatPanel({
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
  const hiddenTimelineEntries = streamingMessageId
    ? Math.max(0, timeline.length - STREAMING_TIMELINE_WINDOW)
    : 0;
  const visibleTimeline =
    hiddenTimelineEntries > 0 ? timeline.slice(hiddenTimelineEntries) : timeline;
  const selectedToolCallId =
    expandedToolCallId === undefined ? selectExpandedToolId(messages) : expandedToolCallId;

  renderLog.event('render', {
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
            {hiddenTimelineEntries} older transcript entries hidden while streaming
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
