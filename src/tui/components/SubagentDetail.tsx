import { Box, Text } from 'ink';
import type { AgentRecord } from '../../agents/types.js';
import { useTheme } from '../theme.js';
import { ChatPanel } from './ChatPanel.js';

export function SubagentDetail({
  record,
  liveText,
  width,
  height,
  reducedMotion = false,
  screenReader = false,
}: {
  record: AgentRecord;
  liveText?: string;
  width: number;
  height: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
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
          Type a follow-up to resume this child · ↓ then Enter main · Esc main · /tasks list
        </Text>
      </Box>
      <ChatPanel
        messages={record.transcript}
        terminalWidth={width}
        terminalHeight={height}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
        model={record.resolvedModel}
        mode="managed"
      />
      {liveText && !['completed', 'failed', 'stopped', 'interrupted'].includes(record.status) ? (
        <Box paddingX={1}>
          <Text color={theme.subtle}>{liveText.slice(-1000)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
