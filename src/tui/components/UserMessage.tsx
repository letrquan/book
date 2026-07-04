import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';

interface UserMessageProps {
  content: string;
  terminalWidth?: number;
}

/**
 * User message block — rendered with a subtle background that spans
 * the available terminal width to visually distinguish user messages.
 */
function UserMessageInner({ content, terminalWidth = 80 }: UserMessageProps) {
  const theme = useTheme();
  const width = Math.max(20, Math.floor(terminalWidth));

  return (
    <Box width={width} paddingX={2} paddingY={1} backgroundColor={theme.userBg}>
      <Box width={Math.max(1, width - 4)}>
        <Text color={theme.text} wrap="wrap">
          {content}
        </Text>
      </Box>
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
