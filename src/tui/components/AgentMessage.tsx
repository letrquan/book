import { Text, Box } from 'ink';
import React, { useMemo } from 'react';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { PermissionButtons } from './PermissionButtons.js';
import { DiffBlock, isUnifiedDiffLike } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { useTheme } from '../theme.js';
import type {
  Message,
  NestedToolInvocation,
  ToolCall,
  PermissionResult,
  RetryPhase,
} from '../../types.js';
import { createRenderDebugLogger } from '../../debug-log.js';

const renderLog = createRenderDebugLogger('tui:agentmsg');

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface AgentMessageProps {
  message: Message;
  isStreaming: boolean;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Terminal width in columns — passed down to MarkdownBlock for word-wrap. */
  terminalWidth?: number;
  /** Retry state — shown in the spinner line when active. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
  /** Hide the inline streaming spinner when an external working indicator owns activity state. */
  hideStreamingSpinner?: boolean;
  /** When true, expanded tool results show the larger output cap instead of a short preview. */
  showAllToolOutput?: boolean;
}

function NestedToolRows({
  invocations,
  parentTraceId,
  depth,
  activeToolCallId,
  reducedMotion,
  screenReader,
  showAllToolOutput,
}: {
  invocations: NestedToolInvocation[];
  parentTraceId: string;
  depth: number;
  activeToolCallId?: string | null;
  reducedMotion: boolean;
  screenReader: boolean;
  showAllToolOutput: boolean;
}) {
  const children = invocations.filter((invocation) => invocation.parentTraceId === parentTraceId);

  return children.map((invocation) => (
    <Box key={invocation.traceId} flexDirection="column" marginLeft={screenReader ? 2 : depth * 2}>
      <ToolCallBlock
        name={invocation.call.name}
        args={invocation.call.arguments}
        result={invocation.result}
        isExpanded={activeToolCallId === invocation.traceId}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
        showAllToolOutput={showAllToolOutput}
      />
      <NestedToolRows
        invocations={invocations}
        parentTraceId={invocation.traceId}
        depth={depth + 1}
        activeToolCallId={activeToolCallId}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
        showAllToolOutput={showAllToolOutput}
      />
    </Box>
  ));
}

/**
 * Strip trailing partial markdown code-fence closings from streaming text.
 *
 * While streaming, the LLM may emit incomplete closing fences (e.g. `` after a
 * ```rust block). These partial markers cause rendered code blocks to visually
 * jitter as the fence opens/closes. This function detects when the last line is
 * a non-empty prefix of a closing fence marker and strips it.
 */
export function trimPartialClosingFences(text: string): string {
  const lines = text.split('\n');
  let lastOpenIdx = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^```/.test(lines[i])) {
      lastOpenIdx = i;
      break;
    }
  }

  if (lastOpenIdx === -1) return text;

  let hasClose = false;
  for (let i = lastOpenIdx + 1; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i])) {
      hasClose = true;
      break;
    }
  }

  if (hasClose) return text;

  const lastLine = lines[lines.length - 1];
  if (lastLine === '') return text;

  const closeMarker = '```';
  if (lastLine !== closeMarker && closeMarker.startsWith(lastLine)) {
    return lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '');
  }

  return text;
}

/** Build the spinner label based on retry state. Exported for testing. */
export function getRetryLabel(
  retryPhase: RetryPhase,
  retryAttempt: number,
  retryMax: number,
  retryCountdownMs: number,
): string | undefined {
  if (retryPhase === 'transport') {
    const countdown = Math.max(0, Math.ceil(retryCountdownMs / 1000));
    const attemptStr =
      retryMax > 0 ? `attempt ${retryAttempt}/${retryMax}` : `attempt ${retryAttempt}`;
    return `Retrying in ${countdown}s · ${attemptStr}`;
  }
  if (retryPhase === 'stalled') {
    const countdown = Math.max(0, Math.ceil(retryCountdownMs / 1000));
    return `Waiting for API response · will retry in ${countdown}s · check your network`;
  }
  if (retryPhase === 'watchdog') {
    return `Retrying (watchdog) · attempt ${retryAttempt}`;
  }
  return undefined;
}

interface ThinkBlockPart {
  kind: 'think';
  text: string;
}

interface MarkdownPart {
  kind: 'markdown';
  text: string;
}

type MessagePart = ThinkBlockPart | MarkdownPart;

export function splitThinkBlocks(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before) parts.push({ kind: 'markdown', text: before });
    parts.push({ kind: 'think', text: match[1].trim() });
    lastIndex = pattern.lastIndex;
  }

  const after = content.slice(lastIndex);
  if (after) parts.push({ kind: 'markdown', text: after });
  return parts.length > 0 ? parts : [{ kind: 'markdown', text: content }];
}

function ThinkBlock({
  text,
  terminalWidth,
  reducedMotion,
}: {
  text: string;
  terminalWidth?: number;
  reducedMotion?: boolean;
}) {
  const theme = useTheme();

  return (
    <Box
      flexDirection="column"
      borderLeft
      borderLeftColor={theme.mdThinkBorder}
      backgroundColor={theme.mdThinkBg}
      paddingLeft={1}
      marginBottom={1}
    >
      <Box>
        <Spinner active style="dots" color={theme.mdThinkText} reducedMotion={reducedMotion} />
        <Text color={theme.mdThinkText} dimColor>
          Thinking
        </Text>
      </Box>
      <Box marginLeft={2}>
        <MarkdownBlock content={text} terminalWidth={terminalWidth} />
      </Box>
    </Box>
  );
}

/**
 * Claude Code-style agent message block.
 *
 * Each assistant turn renders as:
 *   1. Spinner line — shows thinking tips, or retry countdown during retries
 *   2. Streaming text content
 *   3. One tool row per invocation, with Task subagent tools nested below their parent
 *
 * During retries, the spinner line shows Claude Code-style messages:
 *   - Transport retry: "Retrying in 4s · attempt 3/10"
 *   - Stream stall:    "Waiting for API response · will retry in 8s · check your network"
 *   - Watchdog:        "Retrying (watchdog) · attempt 47"
 *
 * When screenReader mode is enabled, all decorations (spinners,
 * box borders, expand/collapse toggles) are stripped for flat,
 * accessible rendering.
 */
export function AgentMessageInner({
  message,
  isStreaming,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  terminalWidth,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
  hideStreamingSpinner = false,
  showAllToolOutput = false,
}: AgentMessageProps) {
  const theme = useTheme();
  const displayContent = isStreaming ? trimPartialClosingFences(message.content) : message.content;

  renderLog.event('render', {
    id: message.id.slice(-8),
    streaming: isStreaming,
    contentLen: displayContent.length,
    toolCalls: (message.toolCalls ?? []).length,
    toolResults: (message.toolResults ?? []).length,
    retry: retryPhase,
  });

  const toolCalls = message.toolCalls ?? [];

  const spinnerLabel = useMemo(
    () => getRetryLabel(retryPhase, retryAttempt, retryMax, retryCountdownMs),
    [retryPhase, retryAttempt, retryMax, retryCountdownMs],
  );

  const isRetrying = retryPhase !== 'none';

  // Compute effective width for MarkdownBlock content.
  // Account for marginLeft (2), spinner (2), and a safety margin (1).
  const mdWidth = terminalWidth ? Math.max(20, terminalWidth - 5) : undefined;
  const contentParts = useMemo(() => splitThinkBlocks(displayContent), [displayContent]);

  return (
    <Box flexDirection="column">
      {/* Spinner line: shows thinking tips, or retry countdown during retries */}
      {isStreaming && !hideStreamingSpinner && !displayContent && !message.toolCalls?.length ? (
        <Box marginLeft={screenReader ? 0 : 2}>
          {isRetrying && spinnerLabel ? (
            <Box>
              <Text color={theme.error}>Retrying: </Text>
              <Text color={theme.error}>{spinnerLabel}</Text>
            </Box>
          ) : (
            <Spinner active style="braille" reducedMotion={reducedMotion} showTips={true} />
          )}
        </Box>
      ) : null}

      {/* Text content with streaming spinner */}
      {displayContent ? (
        <Box marginLeft={screenReader ? 0 : 2} flexDirection="column">
          <Box>
            {isStreaming && !hideStreamingSpinner && !isRetrying && (
              <Spinner active style="braille" reducedMotion={reducedMotion} />
            )}
            {isRetrying && !hideStreamingSpinner && spinnerLabel && (
              <Box>
                <Text color={theme.error}>Retrying: </Text>
                <Text color={theme.error}>{spinnerLabel} </Text>
              </Box>
            )}
            {isUnifiedDiffLike(displayContent) ? (
              <DiffBlock output={displayContent} />
            ) : (
              <Box flexDirection="column">
                {contentParts.map((part, i) =>
                  part.kind === 'think' ? (
                    <ThinkBlock
                      key={`think-${i}`}
                      text={part.text}
                      terminalWidth={mdWidth}
                      reducedMotion={reducedMotion}
                    />
                  ) : (
                    <MarkdownBlock
                      key={`md-${i}`}
                      content={part.text}
                      terminalWidth={mdWidth}
                      isStreaming={isStreaming}
                    />
                  ),
                )}
              </Box>
            )}
          </Box>
        </Box>
      ) : null}

      {/* Every invocation gets its own row. Task subagent tools stay display-only and nest below it. */}
      {toolCalls.map((tc, index) => {
        const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
        const isPending = pendingPermission?.toolCall.id === tc.id;
        return (
          <Box key={tc.id || `tool-${index}`} flexDirection="column">
            <ToolCallBlock
              name={tc.name}
              args={tc.arguments}
              result={result}
              isExpanded={activeToolCallId === tc.id}
              isPending={isPending}
              reducedMotion={reducedMotion}
              screenReader={screenReader}
              showAllToolOutput={showAllToolOutput}
            />
            {isPending && onResolvePermission ? (
              <PermissionButtons
                toolCall={tc}
                onResolve={onResolvePermission}
                screenReader={screenReader}
              />
            ) : null}
            {tc.name === 'Task' ? (
              <NestedToolRows
                invocations={message.nestedToolInvocations ?? []}
                parentTraceId={tc.id}
                depth={1}
                activeToolCallId={activeToolCallId}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                showAllToolOutput={showAllToolOutput}
              />
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Memoized agent message with a custom comparator.
 *
 * Scalar props are compared first (fast path). Message arrays use reference
 * equality because every streaming append/result update replaces its array.
 *
 * `onResolvePermission` is deliberately excluded from the comparison:
 * its identity changes every render (it captures `pendingPermission`), but
 * the important signal — which tool call is pending — is already covered
 * by `pendingPermission?.toolCall?.id`.
 */
export const AgentMessage = React.memo(AgentMessageInner, (prev, next) => {
  // Fast path: same references for the most common props.
  if (
    prev.isStreaming === next.isStreaming &&
    prev.activeToolCallId === next.activeToolCallId &&
    prev.pendingPermission?.toolCall?.id === next.pendingPermission?.toolCall?.id &&
    prev.retryPhase === next.retryPhase &&
    prev.retryAttempt === next.retryAttempt &&
    prev.retryMax === next.retryMax &&
    prev.retryCountdownMs === next.retryCountdownMs &&
    prev.hideStreamingSpinner === next.hideStreamingSpinner &&
    prev.showAllToolOutput === next.showAllToolOutput &&
    prev.reducedMotion === next.reducedMotion &&
    prev.screenReader === next.screenReader &&
    prev.terminalWidth === next.terminalWidth
  ) {
    // Check message identity.
    const pm = prev.message;
    const nm = next.message;
    if (
      pm.id === nm.id &&
      pm.content === nm.content &&
      pm.toolCalls === nm.toolCalls &&
      pm.toolResults === nm.toolResults &&
      pm.nestedToolInvocations === nm.nestedToolInvocations
    ) {
      return true; // skip re-render
    }
  }
  return false;
});
