import { Box, Text } from 'ink';
import { useEffect } from 'react';
import type { CompactUiState } from '../hooks/useAgent.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';

export interface CompactDiffCardProps {
  state: CompactUiState;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  onSettled?: () => void;
}

function compactSummary(state: CompactUiState): string {
  const details: string[] = [];
  if (state.trigger === 'auto') details.push('automatic');
  if (state.preMessages !== undefined) {
    details.push(`${state.preMessages} ${state.preMessages === 1 ? 'message' : 'messages'}`);
  }
  if (state.preContextTokens !== undefined && state.preContextTokens > 0) {
    details.push(`~${Math.round(state.preContextTokens / 100) / 10}k context`);
  }
  if (state.degraded) details.unshift('reduced fidelity');
  return ['Compact conversation', ...details].join(' · ');
}

/** Post-compact status rendered like a tool result without creating a tool invocation. */
export function CompactDiffCard({
  state,
  terminalWidth = 80,
  reducedMotion = false,
  screenReader = false,
  onSettled,
}: CompactDiffCardProps) {
  const theme = useTheme();
  const width = Math.max(12, Math.floor(terminalWidth) - 2);
  const summaryWidth = Math.max(4, width - 4);

  useEffect(() => {
    if (state.phase !== 'diff' || !onSettled) return;
    if (reducedMotion || screenReader) {
      onSettled();
      return;
    }
    const timer = setTimeout(onSettled, 760);
    return () => clearTimeout(timer);
  }, [onSettled, reducedMotion, screenReader, state.phase]);

  if (state.phase === 'working') return null;

  const failed = state.phase === 'error';
  const skipped = state.phase === 'skipped';
  const symbol = failed ? '×' : skipped ? '–' : '✓';
  const color = failed ? theme.error : skipped ? theme.warning : theme.success;
  const summary =
    failed || skipped ? (state.message ?? compactSummary(state)) : compactSummary(state);

  return (
    <Box flexDirection="column" marginLeft={2} width={width}>
      <Box>
        <Text color={color}>{symbol} </Text>
        <Text color={failed ? theme.error : theme.text}>
          {truncateDisplay(summary, summaryWidth)}
        </Text>
      </Box>
      {state.degraded && state.warning ? (
        <Box marginLeft={2} borderLeft borderLeftColor={theme.toolRail} paddingLeft={1}>
          <Text color={theme.warning}>
            {truncateDisplay(state.warning, Math.max(8, width - 6))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
