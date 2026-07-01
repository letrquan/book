import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { useTheme } from '../theme.js';
import {
  getCachedLineEstimate,
  getCachedContentSlice,
  clearLineCache,
} from '../hooks/message-line-cache.js';

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

const MESSAGE_HEADER_ROWS = 3;
const CONTENT_OVERSCAN_ROWS = 8;
const MESSAGE_BOTTOM_MARGIN_ROWS = 1;

interface ViewportIndex<T extends Message> {
  messages: T[];
  starts: number[];
  ends: number[];
  totalLines: number;
}

interface VisibleViewport<T extends Message> {
  messages: T[];
  topOffset: number;
  bottomOffset: number;
}

const viewportIndexCache = new WeakMap<Message[], Map<number, ViewportIndex<Message>>>();

/**
 * Estimate how many terminal rows a message will occupy when rendered.
 *
 * Word-wrap aware: walks text word by word, breaking when a line exceeds
 * terminal width. Words longer than the width are broken mid-word (as Ink
 * does at render time). Empty lines and explicit \n are counted.
 */
export function estimateMessageLines(msg: Message, termWidth: number): number {
  const w = Math.max(20, termWidth);
  let lines = 0;

  if (msg.role === 'user') {
    // UserMessage is one horizontal row plus top/bottom margins.
    return 2 + Math.max(1, estimateWrappedLines(msg.content ?? '', w));
  } else {
    // AgentMessage has top margin, label, label gap, optional body, bottom margin.
    lines = 4;
    const hasBodyLine = Boolean(msg.content) || !msg.toolCalls?.length;
    if (hasBodyLine) {
      lines += Math.max(1, estimateWrappedLines(msg.content ?? '', w));
    }
    if (msg.toolCalls?.length) {
      lines += msg.toolCalls.length;
    }
  }
  return lines;
}

export function estimateWrappedLines(text: string, termWidth: number): number {
  if (!text) return 0;
  const w = Math.max(20, termWidth);
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

export function getViewportIndex<T extends Message>(
  messages: T[],
  terminalWidth: number,
): ViewportIndex<T> {
  let widthMap = viewportIndexCache.get(messages);
  if (!widthMap) {
    widthMap = new Map();
    viewportIndexCache.set(messages, widthMap);
  }

  const width = terminalWidth;
  const cached = widthMap.get(width) as ViewportIndex<T> | undefined;
  if (cached) return cached;

  const starts: number[] = [];
  const ends: number[] = [];
  let totalLines = 0;
  for (const msg of messages) {
    starts.push(totalLines);
    totalLines += getCachedLineEstimate(msg, width, estimateMessageLines);
    ends.push(totalLines);
  }

  const index = { messages, starts, ends, totalLines };
  widthMap.set(width, index as ViewportIndex<Message>);
  return index;
}

export function getEstimatedTranscriptLines(messages: Message[], terminalWidth: number): number {
  return getViewportIndex(messages, terminalWidth).totalLines;
}

function firstGreaterThan(values: number[], needle: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] > needle) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
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
): VisibleViewport<T> {
  return getVisibleViewportFromIndex(
    getViewportIndex(messages, options.terminalWidth ?? 80),
    options,
  );
}

function getVisibleViewportFromIndex<T extends Message>(
  index: ViewportIndex<T>,
  options: {
    scrollOffset?: number;
    maxHeight?: number;
    terminalWidth?: number;
    streamingMessageId?: string | null;
    autoScroll?: boolean;
  },
): VisibleViewport<T> {
  const messages = index.messages;
  if (messages.length === 0) return { messages: [], topOffset: 0, bottomOffset: 0 };

  const scrollOffset = options.scrollOffset ?? 0;
  const maxHeight = options.maxHeight ?? 40;
  const streamingMessageId = options.streamingMessageId ?? null;
  const autoScroll = options.autoScroll ?? true;
  const height = Math.max(5, maxHeight);

  const viewportTop = Math.max(0, index.totalLines - scrollOffset - height);
  const viewportBottom = Math.max(viewportTop, index.totalLines - scrollOffset);
  const first = firstGreaterThan(index.ends, viewportTop);
  const included: T[] = [];

  for (let i = first; i < messages.length; i += 1) {
    if (index.starts[i] >= viewportBottom) break;
    included.push(messages[i]);
  }
  let topOffset = included.length > 0 ? Math.max(0, viewportTop - index.starts[first]) : 0;
  let bottomOffset = 0;
  if (included.length > 0) {
    const last = first + included.length - 1;
    bottomOffset = Math.max(0, index.ends[last] - viewportBottom);
  }

  // Keep the active tail in view only while the viewport is actually pinned to
  // the bottom. Once the user scrolls up, forcing the newest message into the
  // historical slice makes it look mixed into older content.
  if (streamingMessageId && autoScroll && scrollOffset === 0) {
    const tailMessages = messages.slice(-Math.min(3, messages.length));
    for (const tm of tailMessages) {
      if (!included.includes(tm)) included.push(tm);
    }
    if (included.length > 0 && first >= messages.length) topOffset = 0;
    bottomOffset = 0;
  }

  return {
    messages: included,
    topOffset: included.length > 0 ? topOffset : 0,
    bottomOffset: included.length > 0 ? bottomOffset : 0,
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

  const viewportIndex = useMemo(
    () => getViewportIndex(messages, terminalWidth),
    [messages, terminalWidth],
  );
  const visibleViewport = useMemo(
    () =>
      getVisibleViewportFromIndex(viewportIndex, {
        scrollOffset,
        maxHeight,
        terminalWidth,
        streamingMessageId,
        autoScroll,
      }),
    [viewportIndex, scrollOffset, maxHeight, terminalWidth, streamingMessageId, autoScroll],
  );
  const visibleMessages = visibleViewport.messages;
  const renderMessages = useMemo(() => {
    if (
      visibleMessages.length === 0 ||
      (visibleViewport.topOffset <= MESSAGE_HEADER_ROWS && visibleViewport.bottomOffset === 0)
    ) {
      return visibleMessages;
    }

    const first = visibleMessages[0];
    const last = visibleMessages[visibleMessages.length - 1];
    const topContentSkip =
      first.role === 'assistant' && first.content
        ? Math.max(0, visibleViewport.topOffset - MESSAGE_HEADER_ROWS)
        : 0;
    const canBottomCrop =
      last.content &&
      (!last.toolCalls || last.toolCalls.length === 0) &&
      visibleViewport.bottomOffset > 0;
    const bottomContentClip = canBottomCrop
      ? Math.max(0, visibleViewport.bottomOffset - MESSAGE_BOTTOM_MARGIN_ROWS)
      : 0;

    if (topContentSkip === 0 && bottomContentClip === 0) return visibleMessages;

    return visibleMessages.map((msg, index) => {
      const isFirst = index === 0;
      const isLast = index === visibleMessages.length - 1;
      const rowsToSkip = isFirst && msg.role === 'assistant' ? topContentSkip : 0;
      const rowsToClip = isLast && msg === last ? bottomContentClip : 0;
      if (!msg.content || (rowsToSkip === 0 && rowsToClip === 0)) return msg;

      const contentRows = estimateWrappedLines(msg.content, terminalWidth);
      const rowsToKeep =
        rowsToClip > 0
          ? Math.max(0, contentRows - rowsToSkip - rowsToClip)
          : maxHeight + CONTENT_OVERSCAN_ROWS;

      return {
        ...msg,
        content: getCachedContentSlice(msg, terminalWidth, rowsToSkip, rowsToKeep),
      };
    });
  }, [
    visibleMessages,
    visibleViewport.topOffset,
    visibleViewport.bottomOffset,
    terminalWidth,
    maxHeight,
  ]);
  const firstVisibleMessage = visibleMessages[0];
  const topOffset =
    firstVisibleMessage?.role === 'assistant'
      ? Math.min(visibleViewport.topOffset, MESSAGE_HEADER_ROWS)
      : visibleViewport.topOffset;

  const isBrowsing = scrollOffset > 0 && !streamingMessageId;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Auto-scroll paused indicator */}
      {!autoScroll && streamingMessageId && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={theme.warning} bold>
            ⏸ Auto-scroll paused
          </Text>
          <Text color={theme.subtle} dimColor>
            {' '}
            (Ctrl+S to resume)
          </Text>
        </Box>
      )}

      {/* Scroll position indicator when browsing history */}
      {isBrowsing && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={theme.brand} bold>
            ▲ Browsing history
          </Text>
          <Text color={theme.subtle} dimColor>
            {' '}
            (↑↓ to scroll, PgUp/PgDn page, End to bottom)
          </Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" marginTop={topOffset > 0 ? -topOffset : 0}>
          {renderMessages.map((msg) => {
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
