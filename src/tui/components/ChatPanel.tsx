import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { useTheme } from '../theme.js';

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

/**
 * Chat panel — renders messages as Ink components.
 *
 * Uses a virtual viewport: walks oldest→newest, only culls messages below
 * the visible area. Messages above the viewport remain in the React tree
 * but are visually clipped by `overflow: 'hidden'` on the container.
 * This means scrolling up never "discovers" messages — they're already there.
 *
 * scrollOffset controls how many lines above the tail we start from:
 *   0 = show newest messages (tail, auto-scroll)
 *   N = show messages starting N lines above the tail
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

  // Walk oldest→newest: messages above the viewport stay in the tree
  // (clipped by overflow:hidden), only cull messages below the viewport.
  // scrollOffset = lines above the tail. Compute totalLines, then
  // viewport covers [totalLines - scrollOffset - height, totalLines - scrollOffset].
  const visibleMessages = useMemo(() => {
    if (messages.length === 0) return [];

    const height = Math.max(5, maxHeight);

    // Compute total estimated lines for all messages.
    let totalLines = 0;
    for (const msg of messages) {
      totalLines += estimateMessageLines(msg, terminalWidth);
    }

    // Viewport with generous buffer above (2x height) for smooth scroll.
    const viewportTop = Math.max(0, totalLines - scrollOffset - height * 2);
    const viewportBottom = totalLines - scrollOffset + height;

    const included: Message[] = [];
    let lineCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgLines = estimateMessageLines(msg, terminalWidth);
      const msgTop = lineCount;
      lineCount += msgLines;

      // Skip messages entirely above the viewport
      if (lineCount <= viewportTop) continue;
      // Stop once past viewport bottom + buffer
      if (msgTop > viewportBottom) break;

      included.push(msg);
    }

    // During streaming, always include the last few messages to prevent
    // flicker as the streaming content changes height.
    if (streamingMessageId) {
      const tailMessages = messages.slice(-Math.min(10, messages.length));
      for (const tm of tailMessages) {
        if (!included.includes(tm)) {
          included.push(tm);
        }
      }
    }

    return included;
  }, [messages, scrollOffset, maxHeight, terminalWidth, streamingMessageId]);

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
  );
}
