import { Box, Text } from 'ink';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { useTheme } from '../theme.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  /** id of the assistant message currently being streamed into, or null. */
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Retry state for the spinner line. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/**
 * Chat panel — renders messages as Ink components.
 *
 * Pi-style: renders ALL messages top-to-bottom. The terminal's native
 * scrollback buffer preserves history. New content always appears at the
 * bottom; Ink's incremental rendering only rewrites changed lines.
 * No virtual viewport, no scroll offset, no line estimation.
 */
export function ChatPanel({
  messages,
  streamingMessageId,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  const theme = useTheme();

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return <UserMessage key={msg.id} content={msg.content} />;
        }
        return (
          <AgentMessage
            key={msg.id}
            message={msg}
            isStreaming={msg.id === streamingMessageId}
            pendingPermission={pendingPermission}
            onResolvePermission={onResolvePermission}
            activeToolCallId={activeToolCallId}
            reducedMotion={reducedMotion}
            screenReader={screenReader}
            retryPhase={msg.id === streamingMessageId ? retryPhase : 'none'}
            retryAttempt={msg.id === streamingMessageId ? retryAttempt : 0}
            retryMax={msg.id === streamingMessageId ? retryMax : 0}
            retryCountdownMs={msg.id === streamingMessageId ? retryCountdownMs : 0}
          />
        );
      })}
    </Box>
  );
}
