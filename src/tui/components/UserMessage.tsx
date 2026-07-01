import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';

interface UserMessageProps {
  content: string;
}

/**
 * User message block — rendered with a subtle background to visually
 * distinguish user messages from assistant messages.
 */
function UserMessageInner({ content }: UserMessageProps) {
  const theme = useTheme();

  return (
    <Box paddingX={2} paddingY={1} backgroundColor={theme.userBg}>
      <Box flexGrow={1}>
        <Text color={theme.text} wrap="wrap">
          {content}
        </Text>
      </Box>
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
