import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { useTheme } from '../theme.js';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import type { CompactUiState } from '../hooks/useAgent.js';
import { truncateDisplay } from './word-wrap.js';

export interface CompactDiffCardProps {
  state: CompactUiState;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Called once the stagger settles so the host can collapse to a one-liner. */
  onSettled?: () => void;
}

/**
 * Context-diff card shown after a successful compact.
 * Borrows diff theme tokens; does not parse chat as a unified diff.
 * UI-only — never part of provider history.
 */
export function CompactDiffCard({
  state,
  terminalWidth = 80,
  reducedMotion = false,
  screenReader = false,
  onSettled,
}: CompactDiffCardProps) {
  const theme = useTheme();
  const motionDisabled = reducedMotion || screenReader;
  const width = Math.max(24, Math.floor(terminalWidth));
  const contentWidth = Math.max(12, width - 4);

  const playDiff = state.phase === 'diff' || state.phase === 'done';
  const reveal = useStaggeredReveal(4, playDiff && !motionDisabled, 140, motionDisabled);

  useEffect(() => {
    if (!playDiff || !onSettled) return;
    if (motionDisabled) {
      onSettled();
      return;
    }
    const t = setTimeout(onSettled, 140 * 4 + 200);
    return () => clearTimeout(t);
  }, [playDiff, motionDisabled, onSettled]);

  if (state.phase === 'working') {
    return null; // StatusLine owns the busy state.
  }

  if (state.phase === 'skipped' || state.phase === 'error') {
    const color = state.phase === 'error' ? theme.error : theme.subtle;
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Text color={color}>{truncateDisplay(state.message ?? '', contentWidth)}</Text>
      </Box>
    );
  }

  if (!playDiff) return null;

  const pre = state.preMessages ?? 0;
  const preTok = state.preContextTokens;
  const narrow = width < 48;
  const show = (n: number) => motionDisabled || reveal >= n;

  if (narrow) {
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Text>
          <Text color={theme.diffRemoved}>−{pre} msgs</Text>
          <Text color={theme.subtle}> → </Text>
          <Text color={theme.diffAdded}>+summary</Text>
          <Text color={theme.success}> · Conversation compacted</Text>
        </Text>
      </Box>
    );
  }

  const hunk = `@@ context  −${pre} msgs  →  +1 summary @@`;
  const metrics =
    typeof preTok === 'number' && preTok > 0 ? `pre ~${(preTok / 1000).toFixed(1)}k context` : null;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={theme.subtle}
      paddingX={1}
    >
      <Text color={theme.subtle} bold>
        compact
      </Text>
      {show(1) && <Text color={theme.subtle}>{truncateDisplay(hunk, contentWidth)}</Text>}
      {show(2) && (
        <Text color={theme.diffRemoved}>
          {truncateDisplay('−  older conversation turns & tool dumps', contentWidth)}
        </Text>
      )}
      {show(3) && (
        <Text color={theme.diffAdded}>
          {truncateDisplay('+  Structured summary (goals, files, tasks)', contentWidth)}
        </Text>
      )}
      {show(4) && (
        <Box flexDirection="column">
          <Text color={theme.success}>{state.message ?? 'Conversation compacted'}</Text>
          {metrics && <Text color={theme.subtle}>{truncateDisplay(metrics, contentWidth)}</Text>}
        </Box>
      )}
    </Box>
  );
}
