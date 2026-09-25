import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import type { ContextWindowSource } from '../../types/messages.js';
import { stripProvider } from '../../models.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { modeColorToken, modeLabel } from '../mode-style.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { useDebugRender } from '../debug.js';

const renderLog = createRenderDebugLogger('tui:statusline');

/** Marks the permission mode, the one safety-relevant fact in the footer. */
const MODE_CHIP = '◆';

/** `useGitStatus` reports a clean tree as a check mark. */
const CLEAN_TREE = '✓';

/**
 * Segments are separated by a faint middle dot.
 *
 * The dot is drawn a step dimmer than the segments, so it separates them
 * without adding a colour of its own. Colour is kept for a state that needs a
 * decision, not for telling one grey fact from the next.
 */
const SEGMENT_SEPARATOR = '  ·  ';

interface StatusLineProps {
  model: string;
  tokenCount?: number;
  maxTokens?: number;
  maxTokensSource?: ContextWindowSource;
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
  /** Turns written so far; drawn at the right edge as the page's folio. */
  turnCount?: number;
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
  separatorColor?: string,
): Array<{ text: string; color: string }> {
  const result: Array<{ text: string; color: string }> = [];
  let totalWidth = 0;

  for (const segment of segments) {
    const separator = result.length === 0 ? '' : separatorText;
    const candidateWidth = totalWidth + displayWidth(separator) + displayWidth(segment.text);
    if (candidateWidth > maxWidth) continue;

    const color = segment.color ?? 'text';
    if (separator) result.push({ text: separator, color: separatorColor ?? color });
    result.push({ text: segment.text, color });
    totalWidth = candidateWidth;
  }

  return result;
}

/**
 * A page number the way a book prints it in its front matter: `i`, `iv`, `xii`.
 * Zero and negative counts have no folio.
 */
export function romanFolio(count: number): string {
  let n = Math.floor(count);
  if (n <= 0) return '';
  const steps: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [value, numeral] of steps) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

/** Columns kept clear between the last segment and the folio. */
const FOLIO_GAP = 3;

/**
 * Single-row responsive status line.
 *
 * The row aggressively shortens low-priority details before Ink can wrap them,
 * keeping the input area stable while the terminal is resized.
 */
export function StatusLine({
  model,
  tokenCount: _tokenCount,
  maxTokens: _maxTokens,
  maxTokensSource: _maxTokensSource,
  mode,
  taskCount,
  activeTaskCount,
  gitBranch,
  gitStatus,
  agentCount = 0,
  activeAgentCount = 0,
  needsInputAgentCount = 0,
  turnCount = 0,
  terminalWidth = 80,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: StatusLineProps) {
  const theme = useTheme();
  const width = transcriptGrid(terminalWidth).width;
  // Footer rows share the transcript's content column so the status text, the
  // activity label and every tool row start on the same column.
  const horizontalInset = CONTENT_COLUMN;
  // The folio takes the right edge, like a page number in the outer margin. It
  // is the first thing a narrow row gives up.
  const rowWidth = Math.max(8, width - horizontalInset - 1);
  const rawFolio = romanFolio(turnCount);
  const folio = rawFolio && rowWidth >= 40 ? rawFolio : '';
  const contentWidth = folio ? rowWidth - displayWidth(folio) - FOLIO_GAP : rowWidth;

  const motionDisabled = reducedMotion || screenReader;
  const modeFlash = useTimedFlash(mode, 260, motionDisabled);

  useDebugRender(renderLog, {
    width,
    contentWidth,
    compact,
    mode,
    taskCount,
    activeTaskCount,
  });

  // Most of the footer is metadata. Reserve saturated colour for a state that
  // needs a decision, so the transcript and composer keep visual priority.
  // `default` is not a decision — it is the absence of one — so it stays as
  // grey as the model name beside it, whatever the palette's `modeDefault` is.
  const modeColor = mode === 'default' ? theme.subtle : (theme[modeColorToken(mode)] as string);
  const activeModeColor = modeFlash ? theme.brandShimmer : modeColor;

  const coloredRuns = useMemo(() => {
    // The branch outranks the model when the row gets tight. Both are identity,
    // but the branch is the one that changes under you — you chose the model and
    // it stays chosen, while a rebase or a checkout in another worktree moves
    // the branch without asking.
    //
    // Both shrink together rather than one taking the row: packing is first-fit
    // and skips what will not fit, so a branch budget generous enough to crowd
    // the model drops the model entirely instead of shortening it.
    const modelBudget = width < 44 ? 8 : width < 72 ? 14 : 32;
    const branchBudget = width < 44 ? 10 : width < 72 ? 16 : 24;
    const displayModel = stripProvider(model);

    // Ordered by what the reader needs first. Packing is first-fit, not
    // truncating: a segment too wide for the remaining space is skipped and
    // later, shorter ones still get their turn.
    const segments: Array<{ text: string; color?: string }> = [
      { text: `${MODE_CHIP} ${modeLabel(mode)}`, color: activeModeColor },
    ];

    if (gitBranch && gitBranch !== '?') {
      const dirty = Boolean(gitStatus && gitStatus !== CLEAN_TREE);
      // A dirty tree is not a warning. It is how a working tree normally looks,
      // so the `*` says it and the colour stays quiet.
      segments.push({
        text: `${truncateDisplay(gitBranch, branchBudget)}${dirty ? '*' : ''}`,
        color: theme.subtle,
      });
    }

    segments.push({ text: truncateDisplay(displayModel, modelBudget), color: theme.subtle });

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

    return buildColoredSegments(segments, contentWidth, SEGMENT_SEPARATOR, theme.inactive);
  }, [
    gitBranch,
    gitStatus,
    activeTaskCount,
    activeAgentCount,
    agentCount,
    contentWidth,
    mode,
    activeModeColor,
    model,
    taskCount,
    needsInputAgentCount,
    theme.inactive,
    theme.subtle,
    theme.warning,
    width,
  ]);

  const used = coloredRuns.reduce((total, run) => total + displayWidth(run.text), 0);
  return (
    <Box paddingLeft={horizontalInset} width={width} flexDirection="row" flexWrap="nowrap">
      {coloredRuns.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.text}
        </Text>
      ))}
      {folio ? (
        <>
          <Text>{' '.repeat(Math.max(FOLIO_GAP, rowWidth - used - displayWidth(folio)))}</Text>
          <Text color={theme.inactive} italic>
            {folio}
          </Text>
        </>
      ) : null}
    </Box>
  );
}
