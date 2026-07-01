import { Box, Text, useStdout } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';

interface UserMessageProps {
  content: string;
}

/**
 * User message block — rendered with a subtle background that spans
 * the full terminal width to visually distinguish user messages.
 */
function UserMessageInner({ content }: UserMessageProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  return (
    <Box width={termWidth} paddingX={2} paddingY={1} backgroundColor={theme.userBg}>
      <Box flexGrow={1}>
        <Text color={theme.text} wrap="wrap">
          {content}
        </Text>
      </Box>
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
