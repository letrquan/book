import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { PermissionButtons } from './PermissionButtons.js';
import { useTheme } from '../theme.js';
import type { Message, ToolCall, PermissionResult } from '../../types.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface AgentMessageProps {
  message: Message;
  isStreaming: boolean;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

export function AgentMessage({
  message,
  isStreaming,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
}: AgentMessageProps) {
  const theme = useTheme();
  // The hook updates message.content live as tokens stream in, so the
  // displayed content is always the message's own content — no separate
  // streamed-text buffer that could overwrite a previous message.
  const displayContent = message.content;

  // Group consecutive tool calls of the same name into runs (for MCP-style summary).
  const toolCalls = message.toolCalls ?? [];
  const toolCallGroups: ToolCall[][] = [];
  for (const tc of toolCalls) {
    const last = toolCallGroups[toolCallGroups.length - 1];
    if (last && last[0].name === tc.name) {
      last.push(tc);
    } else {
      toolCallGroups.push([tc]);
    }
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box paddingLeft={1} marginBottom={1}>
        <Text color={theme.brand} bold>Book</Text>
      </Box>
      <Box flexDirection="column">
        {isStreaming && !displayContent && !message.toolCalls?.length ? (
          <Box marginLeft={screenReader ? 0 : 2}>
            <Spinner active style="braille" reducedMotion={reducedMotion} />
            <Text color={theme.subtle}>Thinking...</Text>
          </Box>
        ) : null}
        {displayContent ? (
          <Box marginLeft={screenReader ? 0 : 2}>
            {isStreaming && <Spinner active style="braille" reducedMotion={reducedMotion} />}
            <Text color={theme.text}>{displayContent}</Text>
          </Box>
        ) : null}
        {toolCallGroups.map((group, gi) => {
          // Run of consecutive same-name calls.
          // If the run length > 1 and none of them is the active (expanded) tool,
          // collapse to a summary line like "Called read_file 3 times".
          const activeInGroup = group.some((tc) => tc.id === activeToolCallId);
          const showSummary = group.length > 1 && !activeInGroup;
          const everyoneDone = group.every(
            (tc) => message.toolResults?.find((r) => r.toolCallId === tc.id),
          );

          if (showSummary && everyoneDone) {
            return (
              <Box key={`summary-${gi}`} flexDirection="column" marginLeft={2}>
                <Box>
                  <Text color={theme.subtle}>{'▶'} </Text>
                  <Text color={theme.success}>[OK] </Text>
                  <Text color={theme.brand}>Called {group[0].name}</Text>
                  <Text color={theme.subtle}> {group.length} times</Text>
                </Box>
              </Box>
            );
          }

          return group.map((tc, i) => {
            const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
            const isPending = pendingPermission?.toolCall.id === tc.id;
            return (
              <Box key={tc.id || `${gi}-${i}`} flexDirection="column">
                <ToolCallBlock
                  name={tc.name}
                  args={tc.arguments}
                  result={result}
                  isExpanded={activeToolCallId === tc.id}
                  onToggle={() => {}}
                  isPending={isPending}
                  reducedMotion={reducedMotion}
                />
                {isPending && onResolvePermission ? (
                  <PermissionButtons
                    toolCall={tc}
                    onResolve={onResolvePermission}
                  />
                ) : null}
              </Box>
            );
          });
        })}
      </Box>
    </Box>
  );
}
