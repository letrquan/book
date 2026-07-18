import { Box, Text } from 'ink';
import { useEffect } from 'react';
import { useTheme } from '../theme.js';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import type { TranscriptCompactBoundary } from './transcript-messages.js';
import { truncateDisplay } from './word-wrap.js';

export interface CompactDiffCardProps {
  boundary: TranscriptCompactBoundary;
  animated?: boolean;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Called once the newest boundary's reveal settles. */
  onSettled?: () => void;
}

/** Durable, non-chat compact marker rendered inline in transcript order. */
export function CompactDiffCard({
  boundary,
  animated = false,
  terminalWidth = 80,
  reducedMotion = false,
  screenReader = false,
  onSettled,
}: CompactDiffCardProps) {
  const theme = useTheme();
  const motionDisabled = reducedMotion || screenReader;
  const width = Math.max(24, Math.floor(terminalWidth));
  const contentWidth = Math.max(12, width - 4);
  const reveal = useStaggeredReveal(3, animated && !motionDisabled, 140, motionDisabled);

  useEffect(() => {
    if (!animated || !onSettled) return;
    if (motionDisabled) {
      onSettled();
      return;
    }
    const timer = setTimeout(onSettled, 140 * 3 + 200);
    return () => clearTimeout(timer);
  }, [animated, motionDisabled, onSettled]);

  const show = (step: number) => !animated || motionDisabled || reveal >= step;
  const contextChange = `−${boundary.preContextMessages} model-context messages → +checkpoint +${Math.max(
    0,
    boundary.retainedContextMessages - 1,
  )} recent messages`;
  const tokenParts: string[] = [];
  if (typeof boundary.preContextTokens === 'number') {
    tokenParts.push(`pre ~${boundary.preContextTokens.toLocaleString()} tokens`);
  }
  if (typeof boundary.estimatedPostTokens === 'number') {
    tokenParts.push(`post ~${boundary.estimatedPostTokens.toLocaleString()} tokens`);
  }
  tokenParts.push(`generation ${boundary.generation}`);

  if (!animated || width < 58) {
    return (
      <Box flexDirection="column" marginY={1} width={width} paddingX={1}>
        <Text color={theme.subtle}>
          {truncateDisplay('Context compacted · full transcript retained', contentWidth)}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      marginY={1}
      width={width}
      borderStyle="single"
      borderColor={theme.subtle}
      paddingX={1}
    >
      <Text color={theme.success} bold>
        Context compacted · full transcript retained
      </Text>
      {show(1) && <Text color={theme.subtle}>{truncateDisplay(contextChange, contentWidth)}</Text>}
      {show(2) && tokenParts.length > 0 ? (
        <Text color={theme.subtle}>{truncateDisplay(tokenParts.join(' · '), contentWidth)}</Text>
      ) : null}
      {show(3) ? (
        <Text color={theme.subtle} dimColor>
          {boundary.trigger === 'auto' ? 'Automatic compact' : 'Manual compact'}
        </Text>
      ) : null}
    </Box>
  );
}
