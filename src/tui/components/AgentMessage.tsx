import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { PermissionButtons } from './PermissionButtons.js';
import { useTheme } from '../theme.js';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';

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
  /** Retry state — shown in the spinner line when active. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/**
 * Claude Code-style agent message block.
 *
 * Each assistant turn renders as:
 *   1. A "Book" label (like Claude Code's "Claude" label)
 *   2. Spinner line — shows thinking tips, or retry countdown during retries
 *   3. Streaming text content
 *   4. Tool call blocks below the text, grouped by consecutive same-name calls
 *
 * During retries, the spinner line shows Claude Code-style messages:
 *   - Transport retry: "⟳ Retrying in 4s · attempt 3/10"
 *   - Stream stall:    "⏳ Waiting for API response · will retry in 8s · check your network"
 *   - Watchdog:        "⟳ Retrying (watchdog) · attempt 47"
 *
 * When screenReader mode is enabled, all decorations (spinners,
 * box borders, expand/collapse toggles) are stripped for flat,
 * accessible rendering.
 */

/**
 * Strip trailing partial markdown code-fence closings from streaming text.
 *
 * While streaming, the LLM may emit incomplete closing fences (e.g. `` ` ``
 * after a ```rust block). These partial markers cause rendered code blocks
 * to visually jitter as the fence opens/closes. This function detects when
 * the last line is a non-empty prefix of the most recent opening fence
 * marker and strips it.
 *
 * ponytail: only handles ``` fences; tilde fences (~~~) are rarer. Add when supported.
 */
export function trimPartialClosingFences(text: string): string {
  // Find last opening fence: line starting with ``` (maybe with lang suffix)
  const lines = text.split('\n');
  let lastOpenIdx = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^```/.test(lines[i])) {
      lastOpenIdx = i;
      break;
    }
  }

  // No opening fence found — nothing to trim
  if (lastOpenIdx === -1) return text;

  // Find the corresponding closing fence (same-level ``` line after the open,
  // including the last line of text)
  let hasClose = false;
  for (let i = lastOpenIdx + 1; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i])) {
      hasClose = true;
      break;
    }
  }

  // Already has a closing fence — nothing to trim
  if (hasClose) return text;

  const lastLine = lines[lines.length - 1];

  // If last line is empty, nothing to trim
  if (lastLine === '') return text;

  const openMarker = lines[lastOpenIdx];
  // The closing marker is just ``` (no lang suffix)
  const closeMarker = '```';

  // If last line is a non-empty strict prefix of the closing marker, strip it
  // (handles partials like `` or `, not the complete ``` marker)
  if (lastLine !== closeMarker && closeMarker.startsWith(lastLine)) {
    return lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '');
  }

  return text;
}

/**
 * Build the spinner label based on retry state.
 * Exported for testing.
 */
export function getRetryLabel(
  retryPhase: RetryPhase,
  retryAttempt: number,
  retryMax: number,
  retryCountdownMs: number,
): string | undefined {
  if (retryPhase === 'transport') {
    const countdown = Math.max(0, Math.ceil(retryCountdownMs / 1000));
    const attemptStr = retryMax > 0
      ? `attempt ${retryAttempt}/${retryMax}`
      : `attempt ${retryAttempt}`;
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

export function AgentMessage({
  message,
  isStreaming,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: AgentMessageProps) {
  const theme = useTheme();
  const rawContent = message.content;
  const displayContent = isStreaming ? trimPartialClosingFences(rawContent) : rawContent;

  // Group consecutive tool calls of the same name into runs (for MCP-style summary).
  const toolCalls = message.toolCalls ?? [];
  const toolCallGroups: ToolCall[][] = [];
  for (const tc of toolCalls) {
    const last = toolCallGroups[toolCallGroups.length - 1];
    if (last && last[0].name === tc.name) {
      last.push(tc);
    } else {
      toolCallGroups.push([tc]);
    }
  }

  const spinnerLabel = getRetryLabel(retryPhase, retryAttempt, retryMax, retryCountdownMs);
  const isRetrying = retryPhase !== 'none';

  // OSC 133 shell integration — marks assistant message output zones so
  // terminal emulators (iTerm2, WezTerm, Windows Terminal) can display
  // structured input/output boundaries.
  // ponytail: non-OSC-133 terminals ignore these sequences safely.
  const osc133 = isStreaming ? { start: '', end: '' } : { start: '\x1b]133;A\x07', end: '\x1b]133;C\x07' };

  return (
    <>
      {!isStreaming && <Text>{osc133.start}</Text>}
    <Box flexDirection="column" marginY={1}>
      {/* Agent label — like Claude Code's "Claude" */}
      <Box paddingLeft={1} marginBottom={1}>
        <Text color={theme.brand} bold>Book</Text>
      </Box>

      {/* Spinner line: shows thinking tips, or retry countdown during retries */}
      {isStreaming && !displayContent && !message.toolCalls?.length ? (
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
          {/* Retry message on its own line, separated from response content */}
          {isRetrying && spinnerLabel && (
            <Box marginBottom={1}>
              <Text color={theme.error}>⟳ Retrying: </Text>
              <Text color={theme.error}>{spinnerLabel}</Text>
            </Box>
          )}
          <Box>
            {isStreaming && !isRetrying && (
              <Spinner active style="braille" reducedMotion={reducedMotion} />
            )}
            <Text color={theme.text} wrap="wrap">{displayContent}</Text>
          </Box>
        </Box>
      ) : null}

      {/* Tool call blocks */}
      {toolCallGroups.map((group, gi) => {
        // Run of consecutive same-name calls.
        // If the run length > 1 and none of them is the active (expanded) tool,
        // collapse to a summary line like "Called read_file 3 times".
        const activeInGroup = group.some((tc) => tc.id === activeToolCallId);
        const showSummary = group.length > 1 && !activeInGroup;
        const everyoneDone = group.every(
          (tc) => message.toolResults?.find((r) => r.toolCallId === tc.id),
        );

        if (showSummary && everyoneDone) {
          return (
            <Box key={`summary-${gi}`} flexDirection="column" marginLeft={2}>
              <Box>
                <Text color={theme.subtle}>{'▶'} </Text>
                <Text color={theme.success} bold>[OK] </Text>
                <Text color={theme.brand} bold>Called {group[0].name}</Text>
                <Text color={theme.subtle}> {group.length} times</Text>
              </Box>
            </Box>
          );
        }

        return group.map((tc, i) => {
          const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
          const isPending = pendingPermission?.toolCall.id === tc.id;
          return (
            <Box key={tc.id || `${gi}-${i}`} flexDirection="column">
              <ToolCallBlock
                name={tc.name}
                args={tc.arguments}
                result={result}
                isExpanded={activeToolCallId === tc.id}
                isPending={isPending}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
              />
              {isPending && onResolvePermission ? (
                <PermissionButtons
                  toolCall={tc}
                  onResolve={onResolvePermission}
                  screenReader={screenReader}
                />
              ) : null}
            </Box>
          );
        });
      })}
    </Box>
      {!isStreaming && <Text>{osc133.end}</Text>}
    </>
  );
}
