import { Box, Text, Static } from 'ink';
import React, { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { AsciiBanner } from './AsciiBanner.js';
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
  /** Terminal width in columns (used for word-wrap). */
  terminalWidth?: number;
  /** Retry state for the spinner line. */
  retryPhase?: RetryPhase;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/**
 * Merge adjacent assistant messages where the later message has no content
 * but has tool calls/results. This avoids showing a separate "Book" label
 * for tool-call-only turns — they visually merge into the prior message.
 */
function mergeAssistantMessages(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const merged: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i];
    if (current.role !== 'assistant') {
      merged.push(current);
      i++;
      continue;
    }
    // Look ahead: merge any following assistant messages that have no content
    // but have tool calls/results.
    let mergedMsg: Message = { ...current };
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== 'assistant') break;
      if (next.content) break; // has its own text content, don't merge
      // Merge tool calls and tool results.
      mergedMsg = {
        ...mergedMsg,
        toolCalls: [...(mergedMsg.toolCalls ?? []), ...(next.toolCalls ?? [])],
        toolResults: [...(mergedMsg.toolResults ?? []), ...(next.toolResults ?? [])],
      };
      j++;
    }
    merged.push(mergedMsg);
    i = j;
  }
  return merged;
}

/**
 * Chat panel — renders all messages as Ink components in order.
 *
 * Pi-style: no alt-screen, no virtual scrolling, no viewport culling.
 * All messages are rendered and the terminal emulator owns scrollback.
 *
 * Adjacent assistant messages where the later ones have no text content
 * (only tool calls/results) are merged into the prior message so that
 * tool calls appear under a single header rather than repeated ones.
 */
export function ChatPanel({
  messages,
  streamingMessageId,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  terminalWidth: _terminalWidth,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  const theme = useTheme();

  // Merge tool-call-only assistant messages into their preceding message.
  const displayMessages = useMemo(() => mergeAssistantMessages(messages), [messages]);

  // Split messages: completed ones go into <Static> so they persist in
  // terminal scrollback; the streaming message stays in the dynamic area.
  // When not streaming, all messages are completed.
  // Prepend a sentinel so the banner renders as the first static item.
  const BANNER_SENTINEL = '__banner__';
  const completedMessages = useMemo(
    () => {
      const msgs = streamingMessageId
        ? displayMessages.filter((msg) => msg.id !== streamingMessageId)
        : displayMessages;
      return [BANNER_SENTINEL, ...msgs] as Array<Message | typeof BANNER_SENTINEL>;
    },
    [displayMessages, streamingMessageId],
  );
  const activeMessage = useMemo(
    () =>
      streamingMessageId
        ? displayMessages.find((msg) => msg.id === streamingMessageId)
        : undefined,
    [displayMessages, streamingMessageId],
  );

  return (
    <Box flexDirection="column">
      {/* Completed messages rendered via <Static> — preserved in scrollback. */}
      <Static items={completedMessages}>
        {(item) => {
          if (item === BANNER_SENTINEL) {
            return <AsciiBanner key="banner" />;
          }
          const msg = item as Message;
          if (msg.role === 'user') {
            return <UserMessage key={msg.id} content={msg.content} />;
          }
          return (
            <AgentMessage
              key={msg.id}
              message={msg}
              isStreaming={false}
              pendingPermission={pendingPermission}
              onResolvePermission={onResolvePermission}
              activeToolCallId={activeToolCallId}
              reducedMotion={reducedMotion}
              screenReader={screenReader}
            />
          );
        }}
      </Static>

      {/* Active streaming message rendered in the dynamic area. */}
      {activeMessage && (
        <AgentMessage
          key={activeMessage.id}
          message={activeMessage}
          isStreaming={true}
          pendingPermission={pendingPermission}
          onResolvePermission={onResolvePermission}
          activeToolCallId={activeToolCallId}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
          retryPhase={retryPhase}
          retryAttempt={retryAttempt}
          retryMax={retryMax}
          retryCountdownMs={retryCountdownMs}
        />
      )}
    </Box>
  );
}
