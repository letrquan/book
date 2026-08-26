import { Box, Text } from 'ink';
import type { AgentRecord } from '../../agents/types.js';
import type { TranscriptMode } from '../tool-presentation.js';
import { useTheme } from '../theme.js';
import { ChatPanel } from './ChatPanel.js';

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
}) {
  const theme = useTheme();
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
  const hasTranscript = record.transcript.length > 0;
  const streaming = Boolean(liveText) && !terminal;
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
      />
      {streaming ? (
        <Box paddingX={1}>
          <Text color={theme.subtle}>{liveText!.slice(-1000)}</Text>
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
