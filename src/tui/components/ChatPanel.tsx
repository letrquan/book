import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { useTheme } from '../theme.js';
import { getCachedLineEstimate, clearLineCache } from '../hooks/message-line-cache.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  /** id of the assistant message currently being streamed into, or null. */
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /**
   * How many lines back from the tail to start the visible window.
   * 0 = show the newest messages (tail). Higher values scroll further back.
   * Used for Up/Down/PgUp/PgDn navigation through history.
   */
  scrollOffset?: number;
  /** Whether auto-scroll to bottom is enabled (Ctrl+S toggles this). */
  autoScroll?: boolean;
  /** Maximum visible rows for the chat area (used for viewport calculation). */
  maxHeight?: number;
  /** Terminal width in columns (used for line-wrapping estimation). */
  terminalWidth?: number;
  /** Retry state for the spinner line. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/**
 * Estimate how many terminal rows a message will occupy when rendered.
 *
 * Word-wrap aware: walks text word by word, breaking when a line exceeds
 * terminal width. Words longer than the width are broken mid-word (as Ink
 * does at render time). Empty lines and explicit \n are counted.
 */
export function estimateMessageLines(msg: Message, termWidth: number): number {
  const w = Math.max(20, termWidth);
  let lines = 1; // gap/padding between messages

  function wrappedLines(text: string): number {
    if (!text) return 0;
    let count = 0;
    for (const paragraph of text.split('\n')) {
      if (paragraph.length === 0) {
        count += 1;
        continue;
      }
      const words = paragraph.split(' ');
      let lineLen = 0;
      for (const word of words) {
        const wordLen = word.length;
        // If the word itself is longer than terminal width, break it across lines.
        if (wordLen > w) {
          // Flush any partial line first.
          if (lineLen > 0) {
            count += 1;
            lineLen = 0;
          }
          count += Math.floor(wordLen / w);
          lineLen = wordLen % w;
          continue;
        }
        const space = lineLen > 0 ? 1 : 0;
        if (lineLen + space + wordLen > w) {
          count += 1;
          lineLen = wordLen;
        } else {
          lineLen += space + wordLen;
        }
      }
      if (lineLen > 0) count += 1;
    }
    return Math.max(1, count);
  }

  if (msg.role === 'user') {
    lines += 2; // "You" label
    lines += wrappedLines(msg.content ?? '');
  } else {
    lines += 2; // "Book" label
    lines += wrappedLines(msg.content ?? '');
    if (msg.toolCalls?.length) {
      lines += msg.toolCalls.length * 2;
    }
    if (msg.toolResults?.length) {
      lines += msg.toolResults.length;
    }
  }
  return lines;
}

export function getVisibleMessages<T extends Message>(
  messages: T[],
  options: {
    scrollOffset?: number;
    maxHeight?: number;
    terminalWidth?: number;
    streamingMessageId?: string | null;
    autoScroll?: boolean;
  },
): T[] {
  return getVisibleViewport(messages, options).messages;
}

export function getVisibleViewport<T extends Message>(
  messages: T[],
  options: {
    scrollOffset?: number;
    maxHeight?: number;
    terminalWidth?: number;
    streamingMessageId?: string | null;
    autoScroll?: boolean;
  },
): { messages: T[]; topOffset: number } {
  if (messages.length === 0) return { messages: [], topOffset: 0 };

  const scrollOffset = options.scrollOffset ?? 0;
  const maxHeight = options.maxHeight ?? 40;
  const terminalWidth = options.terminalWidth ?? 80;
  const streamingMessageId = options.streamingMessageId ?? null;
  const autoScroll = options.autoScroll ?? true;
  const height = Math.max(5, maxHeight);

  let totalLines = 0;
  for (const msg of messages) {
    totalLines += getCachedLineEstimate(msg, terminalWidth, estimateMessageLines);
  }

  const viewportTop = Math.max(0, totalLines - scrollOffset - height);
  const viewportBottom = totalLines - scrollOffset;
  const included: T[] = [];
  let firstVisibleTop = 0;
  let lineCount = 0;

  for (const msg of messages) {
    const msgLines = getCachedLineEstimate(msg, terminalWidth, estimateMessageLines);
    const msgTop = lineCount;
    lineCount += msgLines;

    if (lineCount <= viewportTop) continue;
    if (msgTop >= viewportBottom) break;

    if (included.length === 0) firstVisibleTop = msgTop;
    included.push(msg);
  }

  // If auto-scroll is enabled while streaming, keep the active tail in the
  // render tree even when line estimates shift by a row. When the user has
  // paused auto-scroll, do not force the tail into a historical viewport.
  if (streamingMessageId && autoScroll) {
    const tailMessages = messages.slice(-Math.min(3, messages.length));
    for (const tm of tailMessages) {
      if (!included.includes(tm)) included.push(tm);
    }
  }

  return {
    messages: included,
    topOffset: included.length > 0 ? Math.max(0, viewportTop - firstVisibleTop) : 0,
  };
}

/**
 * Chat panel — renders messages as Ink components.
 *
 * Uses a virtual viewport: walks oldest→newest and renders the messages that
 * intersect the visible tail window. scrollOffset controls how many lines above
 * the tail we start from: 0 = newest messages, N = browse older history.
 */
export function ChatPanel({
  messages,
  streamingMessageId,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  scrollOffset = 0,
  autoScroll = true,
  maxHeight = 40,
  terminalWidth = 80,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  const theme = useTheme();

  const visibleViewport = useMemo(
    () =>
      getVisibleViewport(messages, {
        scrollOffset,
        maxHeight,
        terminalWidth,
        streamingMessageId,
        autoScroll,
      }),
    [messages, scrollOffset, maxHeight, terminalWidth, streamingMessageId, autoScroll],
  );
  const visibleMessages = visibleViewport.messages;

  const isBrowsing = scrollOffset > 0 && !streamingMessageId;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Auto-scroll paused indicator */}
      {!autoScroll && streamingMessageId && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={theme.warning} bold>⏸ Auto-scroll paused</Text>
          <Text color={theme.subtle} dimColor>
            {' '}(Ctrl+S to resume)
          </Text>
        </Box>
      )}

      {/* Scroll position indicator when browsing history */}
      {isBrowsing && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={theme.brand} bold>▲ Browsing history</Text>
          <Text color={theme.subtle} dimColor>
            {' '}(↑↓ to scroll, PgUp/PgDn page, End to bottom)
          </Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box
          flexDirection="column"
          marginTop={visibleViewport.topOffset > 0 ? -visibleViewport.topOffset : 0}
        >
          {visibleMessages.map((msg) => {
            if (msg.role === 'user') {
              return <UserMessage key={msg.id} content={msg.content} />;
            }
            return (
              <AgentMessage
                key={msg.id}
                message={msg}
                isStreaming={msg.id === streamingMessageId}
                pendingPermission={pendingPermission}
                onResolvePermission={onResolvePermission}
                activeToolCallId={activeToolCallId}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                retryPhase={msg.id === streamingMessageId ? retryPhase : 'none'}
                retryAttempt={msg.id === streamingMessageId ? retryAttempt : 0}
                retryMax={msg.id === streamingMessageId ? retryMax : 0}
                retryCountdownMs={msg.id === streamingMessageId ? retryCountdownMs : 0}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export { clearLineCache };
