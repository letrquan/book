import { Box } from 'ink';
import type { Message, ToolCall, PermissionResult } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  streamingMessage?: Message;
  streamedText: string;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
}

export function ChatPanel({
  messages,
  streamingMessage,
  streamedText,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
}: ChatPanelProps) {
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
            isStreaming={msg === streamingMessage}
            streamedText={streamedText}
            pendingPermission={pendingPermission}
            onResolvePermission={onResolvePermission}
            activeToolCallId={activeToolCallId}
          />
        );
      })}
    </Box>
  );
}
