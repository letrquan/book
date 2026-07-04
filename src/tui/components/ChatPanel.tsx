import { Box, Text, Static } from 'ink';
import React, { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';

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
  /** Terminal height in rows (used for responsive welcome/menu sizing). */
  terminalHeight?: number;
  workspace?: string;
  model?: string;
  mode?: string;
  commandCount?: number;
  skillCount?: number;
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
  terminalWidth,
  terminalHeight,
  workspace,
  model,
  mode,
  commandCount = 0,
  skillCount = 0,
  retryPhase = 'none',
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  // Merge tool-call-only assistant messages into their preceding message.
  const displayMessages = useMemo(() => mergeAssistantMessages(messages), [messages]);

  // Split messages: completed ones go into <Static> so they persist in
  // terminal scrollback; the streaming message stays in the dynamic area.
  // When not streaming, all messages are completed.
  //
  // We prepend a frozen welcome banner to the static items so it appears
  // once at the top of the output and then scrolls away naturally as the
  // conversation grows — it doesn't vanish when the first message arrives.
  const isEmpty = displayMessages.length === 0;
  const rawCompleted = useMemo(
    () => streamingMessageId
      ? displayMessages.filter((msg) => msg.id !== streamingMessageId)
      : displayMessages,
    [displayMessages, streamingMessageId],
  );
  const completedMessages = useMemo(() => {
    if (rawCompleted.length === 0) return rawCompleted;
    // Only prepend the frozen banner once — Ink <Static> deduplicates by key.
    return [
      { id: '__welcome_banner__', role: 'banner' as const, content: '', timestamp: 0 },
      ...rawCompleted,
    ] as (Message & { role: string })[];
  }, [rawCompleted]);
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
        {(msg, index) => {
          // Frozen welcome banner — emitted once to scrollback at the top of
          // the conversation, then scrolls away naturally.
          if ((msg as any).role === 'banner') {
            return (
              <Box key={(msg as any).id as string} marginBottom={1}>
                <WelcomeScreen
                  terminalWidth={terminalWidth ?? 80}
                  terminalHeight={terminalHeight ?? 24}
                  workspace={workspace}
                  model={model}
                  mode={mode}
                  commandCount={commandCount}
                  skillCount={skillCount}
                  reducedMotion={reducedMotion}
                  screenReader={screenReader}
                  animate={false}
                />
              </Box>
            );
          }
          if (msg.role === 'user') {
            return <UserMessage key={msg.id} content={msg.content} terminalWidth={terminalWidth} />;
          }
          // Add a little breathing room when an assistant reply follows a
          // user message, so the AI response isn't flush against the bubble.
          const followsUser = index > 0 && completedMessages[index - 1].role === 'user';
          return (
            <Box key={msg.id} flexDirection="column" marginTop={followsUser ? 1 : 0}>
              <AgentMessage
                message={msg}
                isStreaming={false}
                pendingPermission={pendingPermission}
                onResolvePermission={onResolvePermission}
                activeToolCallId={activeToolCallId}
                reducedMotion={reducedMotion}
                screenReader={screenReader}
                terminalWidth={terminalWidth}
              />
            </Box>
          );
        }}
      </Static>

      {/*
        Animated welcome: plays the intro animation while the conversation is
        empty. Once the first message arrives, this is replaced by a frozen
        copy emitted into <Static> below, where it sits at the top of the
        scrollback and scrolls away naturally as the conversation grows.
      */}
      {isEmpty && (
        <WelcomeScreen
          terminalWidth={terminalWidth ?? 80}
          terminalHeight={terminalHeight ?? 24}
          workspace={workspace}
          model={model}
          mode={mode}
          commandCount={commandCount}
          skillCount={skillCount}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
          animate
        />
      )}

      {/* Active streaming message rendered in the dynamic area. */}
      {activeMessage && (
        <Box
          key={activeMessage.id}
          flexDirection="column"
          marginTop={completedMessages.length > 0 && completedMessages[completedMessages.length - 1].role === 'user' ? 1 : 0}
        >
          <AgentMessage
            message={activeMessage}
            isStreaming={true}
            pendingPermission={pendingPermission}
            onResolvePermission={onResolvePermission}
            activeToolCallId={activeToolCallId}
            reducedMotion={reducedMotion}
            screenReader={screenReader}
            terminalWidth={terminalWidth}
            retryPhase={retryPhase}
            retryAttempt={retryAttempt}
            retryMax={retryMax}
            retryCountdownMs={retryCountdownMs}
          />
        </Box>
      )}
    </Box>
  );
}
