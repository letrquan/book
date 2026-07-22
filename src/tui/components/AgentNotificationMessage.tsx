import { Box, Text } from 'ink';
import type { Message } from '../../types/messages.js';
import { useTheme } from '../theme.js';

function durationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.floor(durationMs / 1000)}s`;
}

export function AgentNotificationMessage({
  message,
  screenReader = false,
}: {
  message: Message;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const notifications = message.agentNotifications ?? [];

  if (notifications.length === 0) {
    return <Text color={theme.subtle}>Agent update: {message.content}</Text>;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.subtle}>
        {screenReader ? 'Subagent completion notification' : 'Agent update'}
      </Text>
      {notifications.map((notification) => {
        const success = notification.status === 'completed';
        const detail = success
          ? notification.summary?.split(/\r?\n/, 1)[0]?.trim() || 'Completed'
          : notification.error?.split(/\r?\n/, 1)[0]?.trim() || notification.status;
        const duration = durationLabel(notification.durationMs);
        return (
          <Text
            key={`${notification.agentId}:${notification.status}`}
            color={success ? theme.success : theme.warning}
          >
            {success ? '[done]' : `[${notification.status}]`} {notification.displayName}: {detail}
            {duration ? ` (${duration})` : ''}
            {notification.evidenceIds.length > 0
              ? ` | ${notification.evidenceIds.length} evidence`
              : ''}
          </Text>
        );
      })}
    </Box>
  );
}
