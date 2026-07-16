import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import type {
  Message,
  PermissionResult,
  PlanApprovalResult,
  RetryPhase,
  ToolCall,
} from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { AsciiBanner } from './AsciiBanner.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { mergeAssistantMessages } from './transcript-messages.js';
import { selectExpandedToolId } from '../tool-traces.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');

function formatTurnTime(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TurnSeparator({
  timestamp,
  terminalWidth,
}: {
  timestamp: number;
  terminalWidth?: number;
}) {
  const theme = useTheme();
  const label = formatTurnTime(timestamp);
  const width = Math.max(20, Math.min(terminalWidth ?? 60, 80));
  const suffix = '─'.repeat(Math.max(5, width - label.length - 4));
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={theme.mdTurnSeparator} dimColor>
        ── {label} {suffix}
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
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/** Dynamically renders transcript content. TranscriptView owns clipping and navigation. */
export function ChatPanel({
  messages,
  streamingMessageId,
  pendingPermission,
  expandedToolCallId,
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
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  useDebugMount(uiLog, { model, mode, commandCount, skillCount });
  const displayMessages = useMemo(
    () => mergeAssistantMessages(messages, streamingMessageId),
    [messages, streamingMessageId],
  );
  const selectedToolCallId =
    expandedToolCallId === undefined ? selectExpandedToolId(messages) : expandedToolCallId;

  renderLog.event('render', {
    total: displayMessages.length,
    active: streamingMessageId?.slice(-8) ?? null,
    isEmpty: displayMessages.length === 0,
  });

  if (displayMessages.length === 0) {
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
      <Box marginBottom={1}>
        <AsciiBanner />
      </Box>
      {displayMessages.map((message, index) => {
        const previous = displayMessages[index - 1];
        if (message.role === 'user') {
          return (
            <Box key={message.id} flexDirection="column">
              {index > 0 ? (
                <TurnSeparator timestamp={message.timestamp} terminalWidth={terminalWidth} />
              ) : null}
              <UserMessage content={message.content} terminalWidth={terminalWidth} />
            </Box>
          );
        }

        const isStreaming = message.id === streamingMessageId;
        return (
          <Box
            key={message.id}
            flexDirection="column"
            marginTop={previous?.role === 'user' ? 1 : 0}
          >
            <AgentMessage
              message={message}
              isStreaming={isStreaming}
              pendingPermission={pendingPermission}
              expandedToolCallId={selectedToolCallId}
              reducedMotion={reducedMotion}
              screenReader={screenReader}
              terminalWidth={terminalWidth}
              retryPhase={isStreaming ? retryPhase : 'none'}
              retryAttempt={isStreaming ? retryAttempt : 0}
              retryMax={isStreaming ? retryMax : 0}
              retryCountdownMs={isStreaming ? retryCountdownMs : 0}
              hideStreamingSpinner={isStreaming}
              showAllToolOutput={showAllToolOutput}
            />
          </Box>
        );
      })}
    </Box>
  );
}
