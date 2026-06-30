import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

interface UserMessageProps {
  content: string;
}

/**
 * Claude Code-style user message block.
 *
 * Renders as:
 *   You  <content>
 * Using the brand color for the "You" label and text color for content.
 */
export function UserMessage({ content }: UserMessageProps) {
  const theme = useTheme();

  return (
    <Box marginY={1} paddingLeft={1}>
      <Box marginRight={1}>
        <Text color={theme.brand} bold>You</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={theme.text} wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}
