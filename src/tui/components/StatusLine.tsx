import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { usePulse, useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { modeColorToken, modeLabel } from '../mode-style.js';
import { CONTENT_COLUMN } from '../layout.js';
import { useDebugRender } from '../debug.js';

const renderLog = createRenderDebugLogger('tui:statusline');

/** Marks the permission mode, the one safety-relevant fact in the footer. */
const MODE_CHIP = '◆';

/** `useGitStatus` reports a clean tree as a check mark. */
const CLEAN_TREE = '✓';

/**
 * Segments are separated by space, not `·`.
 *
 * With every segment the same grey, the dots were the only thing separating
 * them. Now that mode, context pressure and a dirty tree each carry their own
 * colour, the dots are noise the colour already handles.
 */
const SEGMENT_SEPARATOR = '   ';

interface StatusLineProps {
  model: string;
  tokenCount: number;
  maxTokens?: number;
  mode: PermissionMode;
  taskCount: number;
  activeTaskCount: number;
  /** Current branch, when the workspace is a git repository. */
  gitBranch?: string;
  /** Short working-tree summary: `✓` clean, or `+2 ~1`. */
  gitStatus?: string;
  agentCount?: number;
  activeAgentCount?: number;
  needsInputAgentCount?: number;
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
  separatorText = ' · ',
): Array<{ text: string; color: string }> {
  const result: Array<{ text: string; color: string }> = [];
  let totalWidth = 0;

  for (const segment of segments) {
    const separator = result.length === 0 ? '' : separatorText;
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
  maxTokens = 272_000,
  mode,
  taskCount,
  activeTaskCount,
  gitBranch,
  gitStatus,
  agentCount = 0,
  activeAgentCount = 0,
  needsInputAgentCount = 0,
  terminalWidth = 80,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: StatusLineProps) {
  const theme = useTheme();
  const width = Math.max(20, Math.floor(terminalWidth));
  // Footer rows share the transcript's content column so the status text, the
  // activity label and every tool row start on the same column.
  const horizontalInset = CONTENT_COLUMN;
  const contentWidth = Math.max(8, width - horizontalInset - 1);

  const usageFraction = maxTokens > 0 ? tokenCount / maxTokens : 0;
  const usagePercent = Math.round(usageFraction * 100);
  const usageNearLimit = usageFraction > 0.8;
  const usageCritical = usageFraction > 0.95;
  const motionDisabled = reducedMotion || screenReader;
  const usageBlink = usePulse(usageCritical && tokenCount > 0 && !motionDisabled, 500);
  const modeFlash = useTimedFlash(mode, 260, motionDisabled);

  const costEstimate = tokenCount > 0 ? (tokenCount / 1_000_000) * 5 : 0;
  useDebugRender(renderLog, {
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
  // Context pressure is the one number here that is always worth a glance, so
  // it always carries colour — the old row only tinted it past 80%, which left
  // the whole footer a flat grey nobody read.
  const contextColor =
    usageCritical && usageBlink
      ? theme.usageMeterCritical
      : usageCritical
        ? theme.error
        : usageNearLimit
          ? theme.warning
          : theme.usageMeter;

  const coloredRuns = useMemo(() => {
    const modelBudget = width < 44 ? 10 : width < 72 ? 18 : 30;
    // Ordered by what the reader needs first: an oversized later segment is
    // dropped before an earlier one, so priority is left to right.
    const segments: Array<{ text: string; color?: string }> = [
      { text: `${MODE_CHIP} ${modeLabel(mode)}`, color: activeModeColor },
      { text: `ctx ${usagePercent}%`, color: contextColor },
    ];

    if (gitBranch && gitBranch !== '?') {
      const dirty = Boolean(gitStatus && gitStatus !== CLEAN_TREE);
      segments.push({
        text: `${truncateDisplay(gitBranch, width < 72 ? 12 : 24)}${dirty ? '*' : ''}`,
        color: dirty ? theme.warning : theme.subtle,
      });
    }

    segments.push({ text: truncateDisplay(model, modelBudget), color: theme.subtle });

    if (taskCount > 0) {
      segments.push({
        text: `tasks ${activeTaskCount > 0 ? `${activeTaskCount}/` : ''}${taskCount}`,
        color: theme.subtle,
      });
    }

    if (agentCount > 0) {
      segments.push({
        text:
          needsInputAgentCount > 0
            ? `agents ${activeAgentCount} | ${needsInputAgentCount} needs input`
            : `agents ${activeAgentCount}/${agentCount}`,
        color: needsInputAgentCount > 0 ? theme.warning : theme.subtle,
      });
    }

    if (tokenCount > 0 && !compact && width >= 64) {
      segments.push({ text: `$${costEstimate.toFixed(3)}`, color: theme.subtle });
    }

    return buildColoredSegments(segments, contentWidth, SEGMENT_SEPARATOR);
  }, [
    gitBranch,
    gitStatus,
    activeTaskCount,
    activeAgentCount,
    agentCount,
    compact,
    contentWidth,
    costEstimate,
    maxTokens,
    mode,
    activeModeColor,
    contextColor,
    model,
    taskCount,
    needsInputAgentCount,
    tokenCount,
    usagePercent,
    width,
  ]);

  return (
    <Box paddingLeft={horizontalInset} width={width} flexDirection="row" flexWrap="nowrap">
      {coloredRuns.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.text}
        </Text>
      ))}
    </Box>
  );
}
