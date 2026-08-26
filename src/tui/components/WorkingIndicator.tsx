import { Box, Text } from 'ink';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../../types/messages.js';
import type { RetryPhase } from '../../types/runtime.js';
import type {
  PendingElicitationRequest,
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
  PendingUserQuestionRequest,
} from '../../session/agent-interactions.js';
import { useAnimatedProgress, useGradientSpinner } from '../hooks/useAnimation.js';
import { useUiClock } from '../ui-clock.js';
import { useTheme } from '../theme.js';
import type { ThemeTokens } from '../../types/theme.js';
import { deriveWorkingActivity } from '../working-activity.js';
import type { ActivityTone } from '../working-activity.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { formatElapsedDuration } from './SubagentRow.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

interface WorkingIndicatorProps {
  isThinking: boolean;
  /** True while /compact or auto-compact summarization is running. */
  isCompacting?: boolean;
  /** Auto vs manual compact busy label. */
  compactTrigger?: 'manual' | 'auto';
  /** True only after compaction has completed successfully. */
  compactComplete?: boolean;
  messages: Message[];
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermissionRequest | null;
  pendingPlanApproval?: PendingPlanApprovalRequest | null;
  pendingUserQuestion?: PendingUserQuestionRequest | null;
  pendingElicitation?: PendingElicitationRequest | null;
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function useElapsedSeconds(active: boolean, disabled: boolean): number {
  const running = active && !disabled;
  const startedAtRef = useRef(Date.now());
  const resetPendingRef = useRef(true);
  const wasRunningRef = useRef(false);
  const [, refresh] = useState(0);
  const tick = useUiClock('slow', running);

  useLayoutEffect(() => {
    if (running && !wasRunningRef.current) {
      startedAtRef.current = Date.now();
      resetPendingRef.current = false;
      wasRunningRef.current = true;
      refresh((value) => value + 1);
    } else if (!running && wasRunningRef.current) {
      resetPendingRef.current = true;
      wasRunningRef.current = false;
    }
  }, [running]);

  if (!running || resetPendingRef.current) return 0;
  void tick;
  return Math.floor(Math.max(0, Date.now() - startedAtRef.current) / 1000);
}

/**
 * Fit `[label][elapsed][hint]` into one row.
 *
 * The three runs come back separately so each can carry its own colour: the
 * label is the live agent voice, the elapsed time is quiet metadata, the hint
 * is quieter still. Elapsed is dropped first when the row is tight — a duration
 * is the piece a reader can most afford to lose — then the hint, and only then
 * does the label truncate.
 */
function fitActivityLine(
  label: string,
  elapsed: string,
  hint: string,
  maxWidth: number,
): { label: string; elapsed: string; hint: string } {
  const minimumLabelWidth = Math.min(8, maxWidth);
  let suffix = { elapsed, hint };
  const suffixWidth = () => displayWidth(suffix.elapsed) + displayWidth(suffix.hint);

  if (suffixWidth() > maxWidth - minimumLabelWidth) suffix = { elapsed: '', hint };
  if (suffixWidth() > maxWidth - minimumLabelWidth) suffix = { elapsed: '', hint: '' };

  const labelWidth = Math.max(1, maxWidth - suffixWidth());
  return { label: truncateDisplay(label, labelWidth), ...suffix };
}

export interface ActivityPalette {
  /** The spinner glyph, or `◇` when the turn is blocked on the user. */
  indicator: string;
  /** The activity wording. */
  label: string;
  /** Elapsed time and the keyboard hint behind it. */
  meta: string;
}

/**
 * Colours for the activity row.
 *
 * The wording rides the spinner's own colour instead of sitting in `text`. Body
 * prose, plan steps and tool targets are all `text`, so leaving the activity
 * there made the one row that is actually *changing* the hardest row to pick
 * out — a moving glyph welded to a sentence that looked like every other
 * sentence. Sage is the agent's own voice, the same hue as the glyph in front
 * of it, so glyph and wording read as one live element: distinct from the plan
 * (clay) above it and from the transcript around it.
 *
 * A blocked or retrying row is not the agent talking, so it keeps its status
 * colour and the row stops looking live.
 */
export function activityPalette(
  tone: ActivityTone,
  theme: ThemeTokens,
  spinnerColor: string,
): ActivityPalette {
  if (tone === 'warning') {
    return { indicator: theme.warning, label: theme.warning, meta: theme.warning };
  }
  if (tone === 'waiting') {
    return { indicator: theme.permission, label: theme.permission, meta: theme.subtle };
  }
  return { indicator: spinnerColor, label: spinnerColor, meta: theme.subtle };
}

export function WorkingIndicator({
  isThinking,
  isCompacting = false,
  compactTrigger,
  compactComplete = false,
  messages,
  streamingMessageId,
  pendingPermission,
  pendingPlanApproval,
  pendingUserQuestion,
  pendingElicitation,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
  terminalWidth = 80,
  reducedMotion = false,
  screenReader = false,
}: WorkingIndicatorProps) {
  const theme = useTheme();
  const motionDisabled = reducedMotion || screenReader;
  const shouldTrackElapsed =
    isThinking &&
    !isCompacting &&
    retryPhase === 'none' &&
    !pendingPermission &&
    !pendingPlanApproval &&
    !pendingUserQuestion &&
    !pendingElicitation;
  const elapsedSeconds = useElapsedSeconds(shouldTrackElapsed, motionDisabled);
  const activity = deriveWorkingActivity({
    isThinking,
    isCompacting,
    compactTrigger,
    messages,
    streamingMessageId,
    pendingPermission: Boolean(pendingPermission),
    pendingPlanApproval: Boolean(pendingPlanApproval),
    // An MCP form asks the user for input just like a question does.
    pendingUserQuestion: Boolean(pendingUserQuestion || pendingElicitation),
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
    elapsedSeconds,
  });

  const width = transcriptGrid(terminalWidth).width;
  // Footer rows share the transcript's content column so the status text, the
  // activity label and every tool row start on the same column.
  const horizontalInset = CONTENT_COLUMN;
  const contentWidth = Math.max(8, width - horizontalInset - 1);
  const showCompactProgress =
    (isCompacting || compactComplete) && retryPhase === 'none' && !motionDisabled;
  const compactProgress = useAnimatedProgress(isCompacting, 2_400, motionDisabled);
  const spinner = useGradientSpinner(
    Boolean(activity) && !showCompactProgress && !motionDisabled && !activity?.blocked,
    'dots',
    motionDisabled,
  );

  if (!activity && !showCompactProgress) return null;
  if (showCompactProgress) {
    const displayProgress = compactComplete ? 100 : compactProgress;
    const compactLabel = compactComplete
      ? width < 30
        ? 'Done'
        : 'Compacted'
      : compactTrigger === 'auto'
        ? width < 36
          ? 'Auto'
          : 'Auto-compacting'
        : width < 30
          ? 'Compact'
          : 'Compacting';
    const percent = `${String(displayProgress).padStart(3, ' ')}%`;
    const hint = isCompacting && !compactComplete && width >= 52 ? ' · Esc to cancel' : '';
    const barWidth = Math.max(
      1,
      Math.min(
        24,
        contentWidth - displayWidth(compactLabel) - displayWidth(percent) - displayWidth(hint) - 2,
      ),
    );
    const filled = Math.min(barWidth, Math.round((displayProgress / 100) * barWidth));
    const progressColor = compactComplete ? theme.success : theme.brand;

    return (
      <Box paddingLeft={horizontalInset} width={width} flexDirection="row" flexWrap="nowrap">
        <Text color={theme.subtle} dimColor>
          {compactLabel}{' '}
        </Text>
        <Text color={progressColor}>{'█'.repeat(filled)}</Text>
        <Text color={theme.subtle} dimColor>
          {'░'.repeat(barWidth - filled)}
        </Text>
        <Text color={compactComplete ? theme.success : theme.brandShimmer}> {percent}</Text>
        {hint ? (
          <Text color={theme.subtle} dimColor>
            {hint}
          </Text>
        ) : null}
      </Box>
    );
  }

  const hint = pendingPlanApproval
    ? ' · choose approve, adjust, or reject above'
    : pendingUserQuestion || pendingElicitation
      ? ' · answer the question above'
      : pendingPermission
        ? ' · Esc to deny'
        : isThinking || isCompacting
          ? ' · Esc to cancel'
          : '';
  // Rolls up to `4m 8s` / `1h 2m 3s` past a minute, matching subagent rows,
  // background shells and tool rows. A bare second count stops being readable
  // as a duration somewhere around three digits.
  const elapsed =
    shouldTrackElapsed && !motionDisabled ? ` · ${formatElapsedDuration(elapsedSeconds)}` : '';
  const line = fitActivityLine(activity?.label ?? '', elapsed, hint, Math.max(1, contentWidth - 2));
  const indicator = activity?.blocked ? '◇' : spinner.frame;
  const tone = activity?.tone ?? 'normal';
  const palette = activityPalette(tone, theme, spinner.color);

  return (
    <Box width={width} flexWrap="nowrap">
      <Text color={palette.indicator}>{indicator} </Text>
      <Text color={palette.label} bold={tone === 'normal'} dimColor={tone !== 'normal'}>
        {line.label}
      </Text>
      {line.elapsed ? <Text color={palette.meta}>{line.elapsed}</Text> : null}
      {line.hint ? (
        <Text color={palette.meta} dimColor>
          {line.hint}
        </Text>
      ) : null}
    </Box>
  );
}
