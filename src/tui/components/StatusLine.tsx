import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { usePulse, useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { modeColorToken, modeLabel } from '../mode-style.js';

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

function usageMeter(fraction: number, width: number): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return '';
  const filled = Math.min(safeWidth, Math.round(fraction * safeWidth));
  return '█'.repeat(filled) + '░'.repeat(safeWidth - filled);
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
    const separator = result.length === 0 ? '' : ' │ ';
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

  renderLog.event('render', {
    width,
    contentWidth,
    compact,
    meterWidth,
    usagePercent,
    tokenCount,
    mode,
    taskCount,
    activeTaskCount,
  });

  const rowColor =
    usageCritical && usageBlink
      ? theme.usageMeterCritical
      : modeFlash
        ? theme.brandShimmer
        : theme.text;

  const modeColor = theme[modeColorToken(mode)] as string;

  const coloredRuns = useMemo(() => {
    const modelBudget = width < 44 ? 10 : width < 72 ? 18 : 30;
    const tokenText =
      maxTokens > 0
        ? `${(tokenCount / 1000).toFixed(1)}k/${(maxTokens / 1000).toFixed(0)}k`
        : `${(tokenCount / 1000).toFixed(1)}k/?`;
    const tokenSegment =
      meterWidth > 0
        ? `tokens ${tokenText} ${usageMeter(usageFraction, meterWidth)} ${usagePercent}%`
        : `tok ${usagePercent}%`;

    const segments: Array<{ text: string; color?: string }> = [
      { text: modeLabel(mode), color: modeColor },
    ];

    if (usageNearLimit) {
      segments.push({
        text: `ctx ${usagePercent}%`,
        color: usageCritical ? theme.error : theme.warning,
      });
    }

    segments.push(
      { text: truncateDisplay(model, modelBudget), color: rowColor },
      { text: tokenSegment, color: rowColor },
    );

    if (taskCount > 0) {
      segments.push({
        text: `tasks ${activeTaskCount > 0 ? `${activeTaskCount}/` : ''}${taskCount}`,
        color: rowColor,
      });
    }

    if (tokenCount > 0 && !compact && width >= 64) {
      segments.push({ text: `$${costEstimate.toFixed(3)}`, color: rowColor });
    }

    return buildColoredSegments(segments, contentWidth);
  }, [
    activeTaskCount,
    compact,
    contentWidth,
    costEstimate,
    maxTokens,
    meterWidth,
    mode,
    modeColor,
    model,
    rowColor,
    taskCount,
    theme.error,
    theme.warning,
    tokenCount,
    usageFraction,
    usageNearLimit,
    usagePercent,
    width,
  ]);

  return (
    <Box paddingX={1} width={width} flexDirection="row" flexWrap="nowrap">
      {coloredRuns.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.text}
        </Text>
      ))}
    </Box>
  );
}
