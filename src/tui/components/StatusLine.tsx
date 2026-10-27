import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTimedFlash } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import type { ContextWindowSource } from '../../types/messages.js';
import { formatGoalDuration } from '../../agent/goal.js';
import { stripProvider } from '../../models.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { modeColorToken, modeLabel } from '../mode-style.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { useDebugRender } from '../debug.js';
import { romanNumeral } from '../roman.js';

const renderLog = createRenderDebugLogger('tui:statusline');

/** Marks the permission mode, the one safety-relevant fact in the footer. */
const MODE_CHIP = '◆';

/** Marks an active `/goal`: a condition the session is still working toward. */
const GOAL_CHIP = '◎';

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
  /**
   * Reasoning effort, when the model takes one. Shown beside the model, so a
   * change of either is visible where it lives instead of announced in the
   * transcript.
   */
  effort?: string;
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
  /** Peer messages held for the user's approval (#620): `held N` while there are any. */
  heldPeerMessageCount?: number;
  /**
   * Epoch milliseconds at which the session's `/goal` was set, while one is active.
   * Draws `◎ /goal active (<elapsed>)` after the permission mode and keeps it counting.
   */
  goalSetAt?: number;
  /** Turns written so far; drawn at the right edge as the page's folio. */
  turnCount?: number;
  /** The plan's place, `step 3/7`; drawn at the right edge before the folio. */
  stepLabel?: string;
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

/** The status line's folio: the turn count as a front-matter page number. */
export function romanFolio(count: number): string {
  return romanNumeral(count);
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * The goal chip's text. Elapsed time is cut to a whole second before it is formatted, so the
 * text only changes on the ticks `useGoalChip` schedules, however often the row repaints.
 * Under a second there is no duration to show.
 */
function goalChipText(elapsedMs: number): string {
  const wholeSecondsMs = Math.floor(elapsedMs / SECOND_MS) * SECOND_MS;
  const label = `${GOAL_CHIP} /goal active`;
  return wholeSecondsMs === 0 ? label : `${label} (${formatGoalDuration(wholeSecondsMs)})`;
}

/**
 * The goal chip's text while a goal is set, or undefined with none, repainting the row when
 * the text is due to change: on each whole second for the first minute, on each whole
 * minute after. The wait is measured from the goal's own start rather than counted in fixed
 * steps, so a timer that fires early or late corrects itself. Nothing is scheduled without a
 * goal. The clock lives here, in the one row that shows it, so a tick repaints this row and
 * not the whole screen.
 */
function useGoalChip(goalSetAt: number | undefined): string | undefined {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (goalSetAt === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const elapsed = Math.max(0, Date.now() - goalSetAt);
      const step = elapsed < MINUTE_MS ? SECOND_MS : MINUTE_MS;
      const untilNextStep = step - (elapsed % step);
      timer = setTimeout(() => {
        setTick((tick) => tick + 1);
        arm();
      }, untilNextStep);
    };
    arm();
    return () => clearTimeout(timer);
  }, [goalSetAt]);

  return goalSetAt === undefined ? undefined : goalChipText(Math.max(0, Date.now() - goalSetAt));
}

/** Columns kept clear between the last segment and the folio. */
const FOLIO_GAP = 3;

/** Narrowest row that still carries the plan's step. */
const STEP_MIN_ROW_WIDTH = 32;

/** Narrowest row that carries both the step and the folio; the folio goes first. */
const STEP_AND_FOLIO_MIN_ROW_WIDTH = 56;

/**
 * Single-row responsive status line.
 *
 * The row aggressively shortens low-priority details before Ink can wrap them,
 * keeping the input area stable while the terminal is resized.
 */
export function StatusLine({
  model,
  effort,
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
  heldPeerMessageCount = 0,
  goalSetAt,
  turnCount = 0,
  stepLabel,
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
  // The plan's step sits beside the folio. It says more than the page number,
  // so a narrowing row gives up the folio first.
  const step = stepLabel && rowWidth >= STEP_MIN_ROW_WIDTH ? stepLabel : '';
  const rawFolio = romanFolio(turnCount);
  const folio = rawFolio && rowWidth >= (step ? STEP_AND_FOLIO_MIN_ROW_WIDTH : 40) ? rawFolio : '';
  const tailWidth = displayWidth(step) + (step && folio ? FOLIO_GAP : 0) + displayWidth(folio);
  const contentWidth = tailWidth > 0 ? rowWidth - tailWidth - FOLIO_GAP : rowWidth;

  const motionDisabled = reducedMotion || screenReader;
  const modeFlash = useTimedFlash(mode, 260, motionDisabled);
  const goalChip = useGoalChip(goalSetAt);

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

    // Beside the mode: both say how the session is running, so a goal outranks the branch
    // and the model, which only say where and on what.
    if (goalChip) segments.push({ text: goalChip, color: theme.brand });
    // Held peer messages wait on the user, so they rank with the mode, not with the metadata.
    if (heldPeerMessageCount > 0) {
      segments.push({ text: `held ${heldPeerMessageCount}`, color: theme.warning });
    }

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
    if (effort) segments.push({ text: `${effort} effort`, color: theme.inactive });

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
    effort,
    taskCount,
    needsInputAgentCount,
    heldPeerMessageCount,
    goalChip,
    theme.brand,
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
      {tailWidth > 0 ? (
        <>
          <Text>{' '.repeat(Math.max(FOLIO_GAP, rowWidth - used - tailWidth))}</Text>
          {step ? <Text color={theme.subtle}>{step}</Text> : null}
          {step && folio ? <Text>{' '.repeat(FOLIO_GAP)}</Text> : null}
          {folio ? (
            <Text color={theme.inactive} italic>
              {folio}
            </Text>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
