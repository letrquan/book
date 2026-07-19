import { Box, Text } from 'ink';
import type {
  Message,
  PermissionResult,
  PlanApprovalResult,
  RetryPhase,
  ToolCall,
  UserQuestionRequest,
} from '../../types.js';
import { useAnimatedProgress, useGradientSpinner } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { floatingFrameMetrics } from './chrome.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface PendingPlanApproval {
  plan: string;
  resolve: (value: PlanApprovalResult) => void;
}

interface PendingUserQuestion {
  request: UserQuestionRequest;
}

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
  pendingPermission?: PendingPermission | null;
  pendingPlanApproval?: PendingPlanApproval | null;
  pendingUserQuestion?: PendingUserQuestion | null;
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function retryText(
  phase: RetryPhase,
  attempt: number,
  max: number,
  countdownMs: number,
): string | null {
  if (phase === 'none') return null;

  const countdown = Math.max(0, Math.ceil(countdownMs / 1000));
  const attemptText = max > 0 ? `attempt ${attempt}/${max}` : `attempt ${attempt}`;

  if (phase === 'stalled') {
    return `Waiting for API response · retrying in ${countdown}s`;
  }
  if (phase === 'tool') {
    return `Waiting for tool response · retrying in ${countdown}s`;
  }
  if (phase === 'watchdog') {
    return `Retrying watchdog · ${attemptText}`;
  }
  return `Retrying in ${countdown}s · ${attemptText}`;
}

function hasPendingToolResult(message: Message | undefined): boolean {
  if (!message?.toolCalls?.length) return false;
  const completed = new Set((message.toolResults ?? []).map((result) => result.toolCallId));
  return message.toolCalls.some((call) => !completed.has(call.id));
}

function workingText({
  isThinking,
  isCompacting,
  compactTrigger,
  messages,
  streamingMessageId,
  pendingPermission,
  pendingPlanApproval,
  pendingUserQuestion,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: Omit<WorkingIndicatorProps, 'terminalWidth' | 'reducedMotion' | 'screenReader'>): string | null {
  const retry = retryText(retryPhase, retryAttempt, retryMax, retryCountdownMs);
  if (retry) return retry;
  if (isCompacting) {
    return compactTrigger === 'auto' ? 'Auto-compacting…' : 'Compacting…';
  }
  if (!isThinking) return null;
  if (pendingPlanApproval) return 'Waiting for plan approval';
  if (pendingUserQuestion) return 'Waiting for your answer';
  if (pendingPermission) return 'Waiting for permission';

  const activeMessage = streamingMessageId
    ? messages.find((message) => message.id === streamingMessageId)
    : undefined;

  if (hasPendingToolResult(activeMessage)) return 'Waiting for tool response';
  if (activeMessage?.toolCalls?.length && !activeMessage.content) return 'Building tool call';
  if (activeMessage?.content) return 'Generating';
  return 'Thinking';
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
  const label = workingText({
    isThinking,
    isCompacting,
    compactTrigger,
    messages,
    streamingMessageId,
    pendingPermission,
    pendingPlanApproval,
    pendingUserQuestion,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
  });

  const width = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(width);
  const horizontalInset = frame.marginX + 1;
  const contentWidth = Math.max(8, width - horizontalInset * 2);
  const motionDisabled = reducedMotion || screenReader;
  const showCompactProgress =
    (isCompacting || compactComplete) && retryPhase === 'none' && !motionDisabled;
  const compactProgress = useAnimatedProgress(isCompacting, 2_400, motionDisabled);
  const spinner = useGradientSpinner(
    Boolean(label) &&
      !showCompactProgress &&
      !motionDisabled &&
      !pendingPlanApproval &&
      !pendingUserQuestion,
    'dots',
    motionDisabled,
  );

  if (!label && !showCompactProgress) return null;
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
    ? ' · Esc to reject'
    : pendingUserQuestion
      ? ' · answer the question above'
      : pendingPermission
        ? ' · Esc to deny'
        : isThinking || isCompacting
          ? ' · Esc to cancel'
          : '';
  const text = truncateDisplay(`${label}${hint}`, Math.max(1, contentWidth - 2));

  return (
    <Box paddingX={horizontalInset} width={width}>
      <Text color={spinner.color}>{spinner.frame} </Text>
      <Text color={retryPhase !== 'none' ? theme.warning : theme.subtle} dimColor>
        {text}
      </Text>
    </Box>
  );
}
