import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { usePulse, useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { modeColorToken, modeLabel } from '../mode-style.js';
import { floatingFrameMetrics } from './chrome.js';

const renderLog = createRenderDebugLogger('tui:statusline');

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

/**
 * Pack colored status segments from left to right, skipping an oversized
 * segment so that later short, higher-value segments can still be shown.
 */
export function buildColoredSegments(
  segments: Array<{ text: string; color?: string }>,
  maxWidth: number,
): Array<{ text: string; color: string }> {
  const result: Array<{ text: string; color: string }> = [];
  let totalWidth = 0;

  for (const segment of segments) {
    const separator = result.length === 0 ? '' : ' · ';
    const candidateWidth = totalWidth + displayWidth(separator) + displayWidth(segment.text);
    if (candidateWidth > maxWidth) continue;

    const color = segment.color ?? 'text';
    if (separator) result.push({ text: separator, color });
    result.push({ text: segment.text, color });
    totalWidth = candidateWidth;
  }

  return result;
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
  const frame = floatingFrameMetrics(width);
  const horizontalInset = frame.marginX + 1;
  const contentWidth = Math.max(8, width - horizontalInset * 2);

  const usageFraction = maxTokens > 0 ? tokenCount / maxTokens : 0;
  const usagePercent = Math.round(usageFraction * 100);
  const usageNearLimit = usageFraction > 0.8;
  const usageCritical = usageFraction > 0.95;
  const motionDisabled = reducedMotion || screenReader;
  const usageBlink = usePulse(usageCritical && tokenCount > 0 && !motionDisabled, 500);
  const modeFlash = useTimedFlash(mode, 260, motionDisabled);

  const costEstimate = tokenCount > 0 ? (tokenCount / 1_000_000) * 5 : 0;
  renderLog.event('render', {
    width,
    contentWidth,
    compact,
    usagePercent,
    tokenCount,
    mode,
    taskCount,
    activeTaskCount,
  });

  const modeColor = theme[modeColorToken(mode)] as string;
  const activeModeColor = modeFlash ? theme.brandShimmer : modeColor;
  const contextColor =
    usageCritical && usageBlink
      ? theme.usageMeterCritical
      : usageCritical
        ? theme.error
        : usageNearLimit
          ? theme.warning
          : theme.subtle;

  const coloredRuns = useMemo(() => {
    const modelBudget = width < 44 ? 10 : width < 72 ? 18 : 30;
    const segments: Array<{ text: string; color?: string }> = [
      { text: modeLabel(mode), color: activeModeColor },
    ];
    segments.push({ text: truncateDisplay(model, modelBudget), color: theme.subtle });
    segments.push({
      text: `ctx ${usagePercent}%`,
      color: contextColor,
    });

    if (taskCount > 0) {
      segments.push({
        text: `tasks ${activeTaskCount > 0 ? `${activeTaskCount}/` : ''}${taskCount}`,
        color: theme.subtle,
      });
    }

    if (tokenCount > 0 && !compact && width >= 64) {
      segments.push({ text: `$${costEstimate.toFixed(3)}`, color: theme.subtle });
    }

    return buildColoredSegments(segments, contentWidth);
  }, [
    activeTaskCount,
    compact,
    contentWidth,
    costEstimate,
    maxTokens,
    mode,
    activeModeColor,
    contextColor,
    model,
    taskCount,
    tokenCount,
    usagePercent,
    width,
  ]);

  return (
    <Box paddingX={horizontalInset} width={width} flexDirection="row" flexWrap="nowrap">
      {coloredRuns.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.text}
        </Text>
      ))}
    </Box>
  );
}
