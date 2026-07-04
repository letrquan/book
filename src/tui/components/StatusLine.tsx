import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { usePulse, useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';
import { displayWidth, makeDivider, truncateDisplay } from './word-wrap.js';

interface StatusLineProps {
  model: string;
  tokenCount: number;
  maxTokens?: number;
  mode: PermissionMode;
  taskCount: number;
  activeTaskCount: number;
  terminalWidth?: number;
  compact?: boolean;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function usageMeter(fraction: number, width: number): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return '';
  const filled = Math.min(safeWidth, Math.round(fraction * safeWidth));
  return '█'.repeat(filled) + '░'.repeat(safeWidth - filled);
}

function joinSegments(segments: string[], maxWidth: number): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = kept.length === 0 ? segment : `${kept.join(' │ ')} │ ${segment}`;
    if (displayWidth(candidate) <= maxWidth) {
      kept.push(segment);
    }
  }
  return truncateDisplay(kept.join(' │ '), maxWidth);
}

/**
 * Single-row responsive status line.
 *
 * The row aggressively shortens low-priority details before Ink can wrap them,
 * keeping the input area stable while the terminal is resized.
 */
export function StatusLine({
  model,
  tokenCount,
  maxTokens = 128000,
  mode,
  taskCount,
  activeTaskCount,
  terminalWidth = 80,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: StatusLineProps) {
  const theme = useTheme();
  const width = Math.max(20, Math.floor(terminalWidth));
  const contentWidth = Math.max(8, width - 2);

  const usageFraction = maxTokens > 0 ? tokenCount / maxTokens : 0;
  const usagePercent = Math.round(usageFraction * 100);
  const usageNearLimit = usageFraction > 0.8;
  const usageCritical = usageFraction > 0.95;
  const motionDisabled = reducedMotion || screenReader;
  const usageBlink = usePulse(usageCritical && tokenCount > 0 && !motionDisabled, 500);
  const modeFlash = useTimedFlash(mode, 260, motionDisabled);

  const costEstimate = tokenCount > 0 ? (tokenCount / 1_000_000) * 5 : 0;
  const meterWidth = compact || width < 54 ? 0 : width < 78 ? 5 : 8;

  const row = useMemo(() => {
    const modelBudget = width < 44 ? 10 : width < 72 ? 18 : 30;
    const tokenText = maxTokens > 0
      ? `${(tokenCount / 1000).toFixed(1)}k/${(maxTokens / 1000).toFixed(0)}k`
      : `${(tokenCount / 1000).toFixed(1)}k/?`;
    const tokenSegment = meterWidth > 0
      ? `tokens ${tokenText} ${usageMeter(usageFraction, meterWidth)} ${usagePercent}%`
      : `tok ${usagePercent}%`;

    const segments = [
      truncateDisplay(model, modelBudget),
      tokenSegment,
      ...(tokenCount > 0 && !compact && width >= 64 ? [`$${costEstimate.toFixed(3)}`] : []),
      mode,
      ...(taskCount > 0 ? [`tasks ${activeTaskCount > 0 ? `${activeTaskCount}/` : ''}${taskCount}`] : []),
      ...(usageNearLimit && (compact || width < 58) ? [`ctx ${usagePercent}%`] : []),
    ];

    return joinSegments(segments, contentWidth);
  }, [activeTaskCount, compact, contentWidth, costEstimate, maxTokens, meterWidth, mode, model, taskCount, tokenCount, usageFraction, usageNearLimit, usagePercent, width]);

  const warning = usageNearLimit && !compact && width >= 58
    ? truncateDisplay(
        `⚠ ${usageCritical ? 'Context nearly full' : 'Approaching context limit'} — type /compact to summarize older turns`,
        contentWidth,
      )
    : null;

  const rowColor = usageCritical && usageBlink
    ? theme.usageMeterCritical
    : modeFlash
      ? theme.brandShimmer
      : theme.text;

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Text color={theme.subtle}>{makeDivider(width, 2)}</Text>
      <Text color={rowColor}>{row}</Text>
      {warning ? (
        <Text color={usageCritical ? theme.error : theme.warning}>{warning}</Text>
      ) : null}
    </Box>
  );
}
