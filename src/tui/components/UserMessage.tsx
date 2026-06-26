import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  const theme = useTheme();

  return (
    <Box marginY={1} paddingLeft={1}>
      <Box marginRight={1}>
        <Text color={theme.brand} bold>You</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={theme.text}>{content}</Text>
      </Box>
    </Box>
  );
}
