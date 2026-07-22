import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { Message } from '../../types/messages.js';
import type { RetryPhase } from '../../types/runtime.js';
import type {
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
  PendingUserQuestionRequest,
} from '../../session/agent-interactions.js';
import { useAnimatedProgress, useGradientSpinner } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { deriveWorkingActivity } from '../working-activity.js';
import { floatingFrameMetrics } from './chrome.js';
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
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function useElapsedSeconds(active: boolean, disabled: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    if (!active || disabled) return;

    const startedAt = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active, disabled]);

  return seconds;
}

function fitActivityLine(
  label: string,
  elapsed: string,
  hint: string,
  maxWidth: number,
): { label: string; suffix: string } {
  let suffix = `${elapsed}${hint}`;
  const minimumLabelWidth = Math.min(8, maxWidth);

  if (displayWidth(suffix) > maxWidth - minimumLabelWidth) suffix = hint;
  if (displayWidth(suffix) > maxWidth - minimumLabelWidth) suffix = '';

  const labelWidth = Math.max(1, maxWidth - displayWidth(suffix));
  return { label: truncateDisplay(label, labelWidth), suffix };
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
    !pendingUserQuestion;
  const elapsedSeconds = useElapsedSeconds(shouldTrackElapsed, motionDisabled);
  const activity = deriveWorkingActivity({
    isThinking,
    isCompacting,
    compactTrigger,
    messages,
    streamingMessageId,
    pendingPermission: Boolean(pendingPermission),
    pendingPlanApproval: Boolean(pendingPlanApproval),
    pendingUserQuestion: Boolean(pendingUserQuestion),
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
    elapsedSeconds,
  });

  const width = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(width);
  const horizontalInset = frame.marginX + 1;
  const contentWidth = Math.max(8, width - horizontalInset * 2);
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
      <Box paddingX={horizontalInset} width={width} flexDirection="row" flexWrap="nowrap">
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
    : pendingUserQuestion
      ? ' · answer the question above'
      : pendingPermission
        ? ' · Esc to deny'
        : isThinking || isCompacting
          ? ' · Esc to cancel'
          : '';
  const elapsed = shouldTrackElapsed && !motionDisabled ? ` · ${elapsedSeconds}s` : '';
  const line = fitActivityLine(activity?.label ?? '', elapsed, hint, Math.max(1, contentWidth - 2));
  const indicator = activity?.blocked ? '◇' : spinner.frame;
  const indicatorColor =
    activity?.tone === 'warning'
      ? theme.warning
      : activity?.tone === 'waiting'
        ? theme.permission
        : spinner.color;
  const labelColor =
    activity?.tone === 'warning'
      ? theme.warning
      : activity?.tone === 'waiting'
        ? theme.permission
        : theme.text;

  return (
    <Box paddingX={horizontalInset} width={width}>
      <Text color={indicatorColor}>{indicator} </Text>
      <Text color={labelColor} dimColor={activity?.tone !== 'normal'}>
        {line.label}
      </Text>
      {line.suffix ? (
        <Text color={activity?.tone === 'warning' ? theme.warning : theme.subtle} dimColor>
          {line.suffix}
        </Text>
      ) : null}
    </Box>
  );
}
