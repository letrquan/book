import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';

export function Bookplate({ tagline, width }: { tagline: string; width: number }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.assistantAccent} bold>
        {'╭ BOOK'}
      </Text>
      <Text color={theme.toolRail}>
        {'╰ '}
        <Text color={theme.text}>{truncateDisplay(tagline, Math.max(1, width - 2))}</Text>
      </Text>
    </Box>
  );
}
