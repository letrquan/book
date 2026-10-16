import { Box, Text } from 'ink';
import type { CompactUiState } from '../hooks/useAgent.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';

export interface CompactDiffCardProps {
  state: CompactUiState;
  terminalWidth?: number;
}

/** A failed or skipped compaction, rendered like a tool result without creating a tool invocation. */
export function CompactDiffCard({ state, terminalWidth = 80 }: CompactDiffCardProps) {
  const theme = useTheme();
  const width = Math.max(12, Math.floor(terminalWidth) - 2);
  const summaryWidth = Math.max(4, width - 4);

  if (state.phase === 'working') return null;

  const failed = state.phase === 'error';
  const summary = state.message ?? (failed ? 'Compaction failed' : 'Compaction skipped');

  return (
    <Box marginLeft={2} width={width}>
      <Text color={failed ? theme.error : theme.warning}>{failed ? '×' : '–'} </Text>
      <Text color={failed ? theme.error : theme.text}>
        {truncateDisplay(summary, summaryWidth)}
      </Text>
    </Box>
  );
}
