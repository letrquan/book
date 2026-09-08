import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { AgentRecord } from '../../agents/types.js';
import type { Message } from '../../types/messages.js';
import type { TranscriptMode } from '../tool-presentation.js';
import { useTheme } from '../theme.js';
import { AgentMessage } from './AgentMessage.js';
import { ChatPanel } from './ChatPanel.js';

/**
 * The child's in-flight turn, shaped as the assistant message it will become.
 *
 * A managed child streams its text out of band (`agent_text_delta`) and files
 * the finished message afterwards, so while a turn is open there is no
 * `Message` for the transcript to render. Printing the raw buffer under the
 * panel put the child's private reasoning on screen verbatim — a router that
 * inlines thinking as `<think>…</think>` produced a wall of tags — while the
 * same text one row up, in the settled transcript, was collapsed to a
 * `thought` row. Rendering it as a streaming `AgentMessage` gives the live turn
 * the same reasoning split, markdown, and width as every settled one.
 */
function liveMessage(agentId: string, text: string): Message {
  return {
    id: `${agentId}:live`,
    role: 'assistant',
    content: text,
    includeInContext: false,
    timestamp: 0,
  };
}

export function SubagentDetail({
  record,
  liveText,
  width,
  height,
  reducedMotion = false,
  screenReader = false,
  transcriptMode = 'compact',
  automaticToolCallId,
  toolExpansionOverrides,
  showAllToolOutput = false,
  showAllToolOutputIds,
  showThinking = true,
}: {
  record: AgentRecord;
  liveText?: string;
  width: number;
  height: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  transcriptMode?: TranscriptMode;
  automaticToolCallId?: string | null;
  toolExpansionOverrides?: ReadonlyMap<string, boolean>;
  showAllToolOutput?: boolean;
  showAllToolOutputIds?: ReadonlySet<string>;
  showThinking?: boolean;
}) {
  const theme = useTheme();
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
  const hasTranscript = record.transcript.length > 0;
  const streaming = Boolean(liveText) && !terminal;
  const live = useMemo(
    () => (streaming ? liveMessage(record.id, liveText!) : undefined),
    [liveText, record.id, streaming],
  );
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color={theme.brand} bold>
          main &gt; {record.displayName ?? record.name}
        </Text>
        <Text color={theme.subtle}>
          {record.profile ?? record.name} | {record.resolvedModel ?? 'unknown'} |{' '}
          {record.isolation ?? 'worktree'} | {record.status}
        </Text>
        {record.referencedEvidenceIds.length > 0 ? (
          <Text color={theme.subtle}>Evidence: {record.referencedEvidenceIds.join(', ')}</Text>
        ) : null}
        <Text color={theme.subtle}>
          Type a follow-up to resume this child · Tab switch · Esc main · /tasks list
        </Text>
      </Box>
      {/*
        ChatPanel renders nothing for an empty managed transcript, so the
        placeholder / live stream below owns the empty state. Ordering: live
        stream while the child is producing output, then a status placeholder
        only when there is no transcript yet.
      */}
      <ChatPanel
        messages={record.transcript}
        terminalWidth={width}
        terminalHeight={height}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
        model={record.resolvedModel}
        mode="managed"
        transcriptMode={transcriptMode}
        automaticToolCallId={automaticToolCallId}
        toolExpansionOverrides={toolExpansionOverrides}
        showAllToolOutput={showAllToolOutput}
        showAllToolOutputIds={showAllToolOutputIds}
        showThinking={showThinking}
      />
      {live ? (
        <Box flexDirection="column" marginTop={hasTranscript ? 1 : 0}>
          <AgentMessage
            message={live}
            isStreaming
            hideStreamingSpinner
            transcriptMode={transcriptMode}
            reducedMotion={reducedMotion}
            screenReader={screenReader}
            terminalWidth={width}
            showThinking={showThinking}
          />
        </Box>
      ) : !hasTranscript ? (
        <Box paddingX={1}>
          <Text color={theme.subtle}>
            {terminal ? 'No transcript recorded.' : 'Waiting for the subagent to produce output…'}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
