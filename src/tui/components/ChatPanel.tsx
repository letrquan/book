import { Box, Text, Static } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../theme.js';
import type {
  Message,
  ToolCall,
  PermissionResult,
  PlanApprovalResult,
  RetryPhase,
} from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { AsciiBanner } from './AsciiBanner.js';
import { PlanApprovalButtons } from './PlanApprovalButtons.js';
import { createRenderDebugLogger, createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const renderLog = createRenderDebugLogger('tui:chatpanel');
const uiLog = createUiDebugLogger('tui:chatpanel');

function formatTurnTime(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TurnSeparator({
  timestamp,
  terminalWidth,
}: {
  timestamp: number;
  terminalWidth?: number;
}) {
  const theme = useTheme();
  const label = formatTurnTime(timestamp);
  const width = Math.max(20, Math.min(terminalWidth ?? 60, 80));
  const suffix = '─'.repeat(Math.max(5, width - label.length - 4));
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={theme.mdTurnSeparator} dimColor>
        ── {label} {suffix}
      </Text>
    </Box>
  );
}

type StaticChatItem =
  | Message
  | { id: string; role: 'logo'; content: string; timestamp: number }
  | { id: string; role: 'welcome'; content: string; timestamp: number };

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface PendingPlanApproval {
  plan: string;
  resolve: (value: PlanApprovalResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  /** id of the assistant message currently being streamed into, or null. */
  streamingMessageId?: string | null;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  pendingPlanApproval?: PendingPlanApproval | null;
  onResolvePlanApproval?: (result: PlanApprovalResult) => void;
  activeToolCallId?: string | null;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** Terminal width in columns (used for word-wrap). */
  terminalWidth?: number;
  /** Terminal height in rows (used for responsive welcome/menu sizing). */
  terminalHeight?: number;
  /** Remount key used after the terminal viewport has been explicitly cleared. */
  staticEpoch?: number;
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
  handoffMessageIds: ReadonlySet<string> = new Set(),
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
      if (next.id === streamingMessageId || handoffMessageIds.has(next.id)) break;
      // Merge tool calls and tool results.
      mergedMsg = {
        ...mergedMsg,
        toolCalls: [...(mergedMsg.toolCalls ?? []), ...(next.toolCalls ?? [])],
        toolResults: [...(mergedMsg.toolResults ?? []), ...(next.toolResults ?? [])],
        nestedToolInvocations: [
          ...(mergedMsg.nestedToolInvocations ?? []),
          ...(next.nestedToolInvocations ?? []),
        ],
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
  pendingPlanApproval,
  onResolvePlanApproval,
  activeToolCallId,
  reducedMotion = false,
  screenReader = false,
  terminalWidth,
  terminalHeight,
  staticEpoch = 0,
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
  const motionDisabled = reducedMotion || Boolean(pendingPlanApproval);

  // Ink's <Static> permanently writes newly appended items. Queue every
  // completed streaming id so rapid A→B→C transitions cannot skip the empty
  // ownership-gap commit required before each wrapped message enters Static.
  const observedStreamingIdRef = React.useRef(streamingMessageId);
  const handoffQueueRef = React.useRef<string[]>([]);
  const handoffTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [handoffRevision, releaseHandoff] = useState(0);

  if (observedStreamingIdRef.current !== streamingMessageId) {
    const previousId = observedStreamingIdRef.current;
    if (previousId && !handoffQueueRef.current.includes(previousId)) {
      handoffQueueRef.current.push(previousId);
    }
    observedStreamingIdRef.current = streamingMessageId;
  }

  const messageIds = new Set(messages.map((message) => message.id));
  handoffQueueRef.current = handoffQueueRef.current.filter((id) => messageIds.has(id));
  const handoffMessageIds = new Set(handoffQueueRef.current);

  useEffect(() => {
    if (handoffQueueRef.current.length === 0 || handoffTimerRef.current) return;
    handoffTimerRef.current = setTimeout(() => {
      handoffQueueRef.current.shift();
      handoffTimerRef.current = undefined;
      releaseHandoff((revision) => revision + 1);
    }, 50);
  }, [handoffRevision, streamingMessageId, messages]);

  useEffect(
    () => () => {
      if (handoffTimerRef.current) clearTimeout(handoffTimerRef.current);
    },
    [],
  );

  // Merge tool-call-only assistant messages into their preceding message.
  const displayMessages = useMemo(() => {
    const merged = mergeAssistantMessages(messages, streamingMessageId, handoffMessageIds);
    if (messages.length !== merged.length) {
      renderLog.event('merge', {
        before: messages.length,
        after: merged.length,
        merged: messages.length - merged.length,
      });
    }
    return merged;
  }, [messages, streamingMessageId, handoffRevision]);

  // Split messages: completed ones go into <Static> so they persist in
  // terminal scrollback; streaming and handoff messages stay dynamic.
  const isEmpty = displayMessages.length === 0;
  const rawCompletedMessages = useMemo(
    () =>
      displayMessages.filter(
        (msg) => msg.id !== streamingMessageId && !handoffMessageIds.has(msg.id),
      ),
    [displayMessages, streamingMessageId, handoffRevision],
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
      streamingMessageId ? displayMessages.find((msg) => msg.id === streamingMessageId) : undefined,
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
    handoff: handoffQueueRef.current.map((id) => id.slice(-8)),
    active: activeMessage?.id.slice(-8) ?? null,
    isEmpty,
  });

  return (
    <Box flexDirection="column">
      {/* Static content is emitted once to terminal scrollback; keep large banners out of dynamic repaint paths. */}
      <Static key={staticEpoch} items={staticItems}>
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
                reducedMotion={motionDisabled}
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
            const previous = completedMessages[index - 1];
            const showSeparator = index > 0 && previous?.role !== 'logo';
            return (
              <Box key={msg.id} flexDirection="column">
                {showSeparator ? (
                  <TurnSeparator timestamp={msg.timestamp} terminalWidth={terminalWidth} />
                ) : null}
                <UserMessage content={msg.content} terminalWidth={terminalWidth} />
              </Box>
            );
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
                reducedMotion={motionDisabled}
                screenReader={screenReader}
                terminalWidth={terminalWidth}
                showAllToolOutput={showAllToolOutput}
              />
            </Box>
          );
        }}
      </Static>

      {/* The previous streaming message is withheld for one commit before it
          enters <Static>. This empty ownership gap lets Ink erase the old
          dynamic frame before permanently writing the completed message. */}

      {/* Active streaming message rendered in the dynamic area. */}
      {activeMessage && (
        <Box
          key={activeMessage.id}
          flexDirection="column"
          marginTop={
            completedMessages.length > 0 &&
            completedMessages[completedMessages.length - 1].role === 'user'
              ? 1
              : 0
          }
        >
          <AgentMessage
            message={activeMessage}
            isStreaming={true}
            pendingPermission={pendingPermission}
            onResolvePermission={onResolvePermission}
            activeToolCallId={activeToolCallId}
            reducedMotion={motionDisabled}
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

      {pendingPlanApproval && onResolvePlanApproval && (
        <PlanApprovalButtons
          plan={pendingPlanApproval.plan}
          onResolve={onResolvePlanApproval}
          screenReader={screenReader}
        />
      )}
    </Box>
  );
}
