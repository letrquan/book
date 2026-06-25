import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { PermissionButtons } from './PermissionButtons.js';
import { usePulse } from '../hooks/useAnimation.js';
import type { Message, ToolCall, PermissionResult } from '../../types.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface AgentMessageProps {
  message: Message;
  isStreaming: boolean;
  streamedText: string;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
}

export function AgentMessage({
  message,
  isStreaming,
  streamedText,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
}: AgentMessageProps) {
  const isPulse = usePulse(isStreaming && !message.content && !message.toolCalls?.length, 500);
  const displayContent = isStreaming ? streamedText : message.content;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box paddingLeft={1} marginBottom={1}>
        <Text color="cyan" bold>Book</Text>
      </Box>
      <Box flexDirection="column">
        {isStreaming && !displayContent && !message.toolCalls?.length ? (
          <Box marginLeft={2}>
            <Spinner active style="braille" />
            <Text color="gray">Thinking...</Text>
          </Box>
        ) : null}
        {displayContent ? (
          <Box marginLeft={2}>
            {isStreaming && <Spinner active style="braille" />}
            <Text color="white">{displayContent}</Text>
          </Box>
        ) : null}
        {message.toolCalls?.map((tc, i) => {
          const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
          const isPending = pendingPermission?.toolCall.id === tc.id;
          return (
            <Box key={tc.id || i} flexDirection="column">
              <ToolCallBlock
                name={tc.name}
                args={tc.arguments}
                result={result}
                isExpanded={activeToolCallId === tc.id}
                onToggle={() => {}}
                isPending={isPending}
              />
              {isPending && onResolvePermission ? (
                <PermissionButtons
                  toolCall={tc}
                  onResolve={onResolvePermission}
                />
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
