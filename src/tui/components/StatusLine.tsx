import { Box, Text, useStdout } from 'ink';
import { useMemo } from 'react';
import { usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';

interface StatusLineProps {
  model: string;
  tokenCount: number;
  maxTokens?: number;
  mode: PermissionMode;
  taskCount: number;
  activeTaskCount: number;
}

/**
 * Single-row status line at the absolute bottom of the screen.
 *
 * Shows model, token usage bar + percentage + cost, mode, and tasks
 * all in one compact row with a divider line above.
 */
export function StatusLine({
  model,
  tokenCount,
  maxTokens = 128000,
  mode,
  taskCount,
  activeTaskCount,
}: StatusLineProps) {
  const theme = useTheme();

  // Usage meter
  const usageFraction = maxTokens > 0 ? tokenCount / maxTokens : 0;
  const usagePercent = Math.round(usageFraction * 100);
  const usageNearLimit = usageFraction > 0.8;
  const usageCritical = usageFraction > 0.95;
  const usageBlink = usePulse(usageCritical && tokenCount > 0, 500);

  // Cost estimate — blended ~$5/M tokens.
  const costEstimate = tokenCount > 0 ? (tokenCount / 1_000_000) * 5 : 0;

  const meterSegments = 8;
  const filledSegments = Math.min(meterSegments, Math.round(usageFraction * meterSegments));
  const meterBar = '█'.repeat(filledSegments) + '░'.repeat(meterSegments - filledSegments);

  const meterColor = usageCritical && usageBlink
    ? theme.usageMeterCritical
    : usageNearLimit
      ? theme.usageMeterHigh
      : theme.usageMeter;

  // Build a full-width divider line matching the terminal width.
  const { stdout } = useStdout();
  const divider = useMemo(() => {
    const width = stdout?.columns ?? 80;
    // Subtract 2 for the left/right padding (paddingX={1}).
    return '─'.repeat(Math.max(5, width - 2));
  }, [stdout?.columns]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Full-width divider */}
      <Text color={theme.subtle}>{divider}</Text>

      {/* Single row: model │ tokens + bar + % │ cost │ mode │ tasks */}
      <Box>
        <Text color={theme.text} bold>{model}</Text>
        <Text color={theme.subtle} dimColor>  │  </Text>
        <Text color={theme.subtle} dimColor>tokens </Text>
        <Text color={usageCritical && usageBlink ? theme.usageMeterCritical : theme.text}>
          {(tokenCount / 1000).toFixed(1)}k/{maxTokens > 0 ? `${(maxTokens / 1000).toFixed(0)}k` : '?'}
        </Text>
        <Text color={theme.subtle} dimColor> </Text>
        <Text color={meterColor}>{meterBar}</Text>
        <Text color={theme.subtle} dimColor> {usagePercent}%</Text>
        {tokenCount > 0 ? (
          <>
            <Text color={theme.subtle} dimColor>  │  </Text>
            <Text color={theme.subtle}>${costEstimate.toFixed(3)}</Text>
          </>
        ) : null}
        <Text color={theme.subtle} dimColor>  │  </Text>
        <Text color={theme.promptBorder} bold>{mode}</Text>
        {taskCount > 0 ? (
          <>
            <Text color={theme.subtle} dimColor>  │  tasks </Text>
            <Text color={theme.text}>
              {activeTaskCount > 0 ? `${activeTaskCount}/` : ''}{taskCount}
            </Text>
          </>
        ) : null}
      </Box>

      {/* Context limit warning */}
      {usageNearLimit && (
        <Box>
          <Text color={usageCritical ? theme.error : theme.warning}>
            ⚠ {usageCritical ? 'Context nearly full' : 'Approaching context limit'}
            {' — '}
          </Text>
          <Text color={theme.subtle} dimColor>
            type /compact to summarize older turns
          </Text>
        </Box>
      )}
    </Box>
  );
}
