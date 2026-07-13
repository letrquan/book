import { Box, Text, Static } from 'ink';
import React, { useMemo } from 'react';
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
import {
  assertDisjointZones,
  mergeAssistantMessages,
  partitionMessageZones,
  useStaticHandoff,
} from '../hooks/static-handoff.js';

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

  // Deterministic Static handoff: previous streaming id is withheld immediately;
  // a passive effect releases one queued id after a gap frame (FIFO for A→B→C).
  const { withheldQueue, withheldIds } = useStaticHandoff(streamingMessageId, messages);
  const handoffMessageIds = withheldIds;

  // Merge tool-call-only assistant messages into their preceding message (display-only).
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
  }, [messages, streamingMessageId, handoffMessageIds]);

  // Split messages: completed ones go into <Static> so they persist in
  // terminal scrollback; streaming and handoff messages stay dynamic.
  const isEmpty = displayMessages.length === 0;
  const rawCompletedMessages = useMemo(
    () =>
      displayMessages.filter(
        (msg) => msg.id !== streamingMessageId && !handoffMessageIds.has(msg.id),
      ),
    [displayMessages, streamingMessageId, handoffMessageIds],
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

  const zones = partitionMessageZones(
    messages.map((message) => message.id),
    streamingMessageId,
    withheldQueue,
  );
  const zonesDisjoint = assertDisjointZones(zones);

  renderLog.event('render', {
    total: displayMessages.length,
    completed: completedMessages.length,
    handoff: withheldQueue.map((id) => id.slice(-8)),
    active: activeMessage?.id.slice(-8) ?? null,
    staticEpoch,
    zonesDisjoint,
    isEmpty,
  });

  return (
    <Box flexDirection="column">
      {/* Static content is emitted once to terminal scrollback; keep large banners out of dynamic repaint paths.
          key={staticEpoch} remounts Static after an explicit viewport clear so history is re-emitted. */}
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

      {/* The previous streaming message is withheld for one gap frame before it
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
