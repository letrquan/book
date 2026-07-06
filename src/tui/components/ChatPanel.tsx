import { Box, Text, Static } from 'ink';
import React, { useMemo } from 'react';
import type { Message, ToolCall, PermissionResult, RetryPhase } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { AsciiBanner } from './AsciiBanner.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');

type StaticChatItem =
  | Message
  | { id: string; role: 'logo'; content: string; timestamp: number }
  | { id: string; role: 'welcome'; content: string; timestamp: number };

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
  /** When true, expanded tool results show the larger output cap instead of a short preview. */
  showAllToolOutput?: boolean;
  retryAttempt?: number;
  retryMax?: number;
  retryCountdownMs?: number;
}

/**
 * Merge adjacent assistant messages where the later message has no content
 * but has tool calls/results. This avoids showing a separate "Book" label
 * for tool-call-only turns — they visually merge into the prior message.
 */
function mergeAssistantMessages(
  messages: Message[],
  streamingMessageId?: string | null,
): Message[] {
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
    // but have tool calls/results. Never merge the active streaming message:
    // it must keep its identity so it stays in the dynamic render area and can
    // show permission prompts outside Ink's <Static> scrollback.
    let mergedMsg: Message = { ...current };
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== 'assistant') break;
      if (next.content) break; // has its own text content, don't merge
      if (next.id === streamingMessageId) break;
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
  showAllToolOutput = false,
  retryAttempt = 0,
  retryMax = 0,
  retryCountdownMs = 0,
}: ChatPanelProps) {
  useDebugMount(uiLog, { model, mode, commandCount, skillCount });

  // Merge tool-call-only assistant messages into their preceding message.
  const displayMessages = useMemo(() => {
    const merged = mergeAssistantMessages(messages, streamingMessageId);
    if (messages.length !== merged.length) {
      renderLog.event('merge', {
        before: messages.length,
        after: merged.length,
        merged: messages.length - merged.length,
      });
    }
    return merged;
  }, [messages, streamingMessageId]);

  // Split messages: completed ones go into <Static> so they persist in
  // terminal scrollback; the streaming message stays in the dynamic area.
  // When not streaming, all messages are completed.
  const isEmpty = displayMessages.length === 0;
  const rawCompletedMessages = useMemo(
    () => streamingMessageId
      ? displayMessages.filter((msg) => msg.id !== streamingMessageId)
      : displayMessages,
    [displayMessages, streamingMessageId],
  );
  const completedMessages = useMemo(() => {
    if (rawCompletedMessages.length === 0) return rawCompletedMessages;
    return [
      { id: '__book_logo__', role: 'logo' as const, content: '', timestamp: 0 },
      ...rawCompletedMessages,
    ] as StaticChatItem[];
  }, [rawCompletedMessages]);
  const activeMessage = useMemo(
    () =>
      streamingMessageId
        ? displayMessages.find((msg) => msg.id === streamingMessageId)
        : undefined,
    [displayMessages, streamingMessageId],
  );

  const staticItems = useMemo(() => {
    if (isEmpty) {
      return [
        { id: '__welcome_landing__', role: 'welcome' as const, content: '', timestamp: 0 },
      ] as StaticChatItem[];
    }
    return completedMessages;
  }, [completedMessages, isEmpty]);

  renderLog.event('render', {
    total: displayMessages.length,
    completed: completedMessages.length,
    active: Boolean(activeMessage),
    isEmpty,
  });

  return (
    <Box flexDirection="column">
      {/* Static content is emitted once to terminal scrollback; keep large banners out of dynamic repaint paths. */}
      <Static items={staticItems}>
        {(msg, index) => {
          if (msg.role === 'welcome') {
            return (
              <WelcomeScreen
                key={msg.id}
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
            );
          }
          if (msg.role === 'logo') {
            return (
              <Box key={msg.id} marginBottom={1}>
                <AsciiBanner />
              </Box>
            );
          }
          if (msg.role === 'user') {
            return <UserMessage key={msg.id} content={msg.content} terminalWidth={terminalWidth} />;
          }
          // Add a little breathing room when an assistant reply follows a
          // user message, so the AI response isn't flush against the bubble.
          const previous = completedMessages[index - 1];
          const followsUser = index > 0 && previous?.role === 'user';
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
                showAllToolOutput={showAllToolOutput}
              />
            </Box>
          );
        }}
      </Static>

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
            hideStreamingSpinner
            showAllToolOutput={showAllToolOutput}
          />
        </Box>
      )}
    </Box>
  );
}
