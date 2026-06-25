import { Box, Text } from 'ink';

interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <Box marginY={1} paddingLeft={1}>
      <Box marginRight={1}>
        <Text color="cyan" bold>You</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="white">{content}</Text>
      </Box>
    </Box>
  );
}
