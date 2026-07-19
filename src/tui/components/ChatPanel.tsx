import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import type {
  CompactBoundary,
  Message,
  PermissionResult,
  PlanApprovalResult,
  RetryPhase,
  ToolCall,
} from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { useDensity } from '../density.js';
import { mergeAssistantMessages } from './transcript-messages.js';
import { selectExpandedToolId } from '../tool-traces.js';
import type { TranscriptMode } from '../tool-presentation.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');

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

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface PendingPlanApproval {
  plan: string;
  resolve: (value: PlanApprovalResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  compactBoundaries?: CompactBoundary[];
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermission | null;
  /** @deprecated Approval actions now render in App's fixed interaction area. */
  onResolvePermission?: (result: PermissionResult) => void;
  /** @deprecated Plan details/actions now render outside ChatPanel. */
  pendingPlanApproval?: PendingPlanApproval | null;
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
  compactBoundaries = [],
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
  const timeline = useMemo(
    () => buildTimeline(messages, compactBoundaries, streamingMessageId),
    [messages, compactBoundaries, streamingMessageId],
  );
  const selectedToolCallId =
    expandedToolCallId === undefined ? selectExpandedToolId(messages) : expandedToolCallId;

  renderLog.event('render', {
    total: timeline.length,
    active: streamingMessageId?.slice(-8) ?? null,
    isEmpty: timeline.length === 0,
  });

  if (timeline.length === 0) {
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
      {timeline.map((entry, index) => {
        if ('transcriptOrdinal' in entry) {
          return <CompactBoundaryRow key={`boundary-${entry.id}`} boundary={entry} />;
        }
        const message = entry;
        const previous = timeline[index - 1];
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
                terminalWidth={terminalWidth}
                screenReader={screenReader}
              />
            </Box>
          );
        }

        const isStreaming = message.id === streamingMessageId;
        const next = timeline[index + 1];
        const nextEntryIsUser = Boolean(next && 'role' in next && next.role === 'user');
        return (
          <Box
            key={message.id}
            flexDirection="column"
            marginTop={
              previous && 'role' in previous && previous.role === 'user' && density !== 'tight'
                ? 1
                : 0
            }
          >
            {screenReader ? (
              <ScreenReaderRoleLabel role="assistant" timestamp={message.timestamp} />
            ) : null}
            <AgentMessage
              message={message}
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
    if (index < messages.length) segment.push(messages[index]);
  }
  flush();
  return timeline;
}

function CompactBoundaryRow({ boundary }: { boundary: CompactBoundary }) {
  const theme = useTheme();
  const removed = Math.max(0, boundary.preContextCount - boundary.postContextCount);
  const tokens =
    boundary.preContextTokens !== undefined && boundary.postContextTokens !== undefined
      ? ` · ~${formatCompactNumber(boundary.preContextTokens)} → ~${formatCompactNumber(boundary.postContextTokens)} tokens`
      : '';
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <Text color={theme.subtle}>Context compacted · full transcript retained</Text>
      <Text color={theme.subtle} dimColor>
        −{removed} context messages → checkpoint + {Math.max(0, boundary.postContextCount - 1)}{' '}
        recent messages{tokens} · generation {boundary.generation}
      </Text>
    </Box>
  );
}

function formatCompactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  return `${Math.round(value / 1_000)}k`;
}
