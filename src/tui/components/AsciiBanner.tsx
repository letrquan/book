import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

/**
 * ASCII "BOOK" banner displayed at the top of the TUI.
 * Uses the brand color and sits above the status line.
 */
export function AsciiBanner() {
  const theme = useTheme();

  const lines = [
    '  ██████╗   ██████╗   ██████╗  ██╗  ██╗',
    '  ██╔══██╗ ██╔═══██╗ ██╔═══██╗ ██║ ██╔╝',
    '  ██████╔╝ ██║   ██║ ██║   ██║ █████╔╝ ',
    '  ██╔══██╗ ██║   ██║ ██║   ██║ ██╔═██╗ ',
    '  ██████╔╝ ╚██████╔╝ ╚██████╔╝ ██║  ██╗',
    '  ╚═════╝   ╚═════╝   ╚═════╝  ╚═╝  ╚═╝',
  ];

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {lines.map((line, i) => (
        <Text key={i} color={theme.brand} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}
