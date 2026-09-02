import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import type { AgentSummary } from '../../agents/types.js';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN } from '../layout.js';
import { SubagentRow } from './SubagentRow.js';
import { BackgroundShellRow } from './BackgroundShellRow.js';

export function SubagentPanel({
  agents,
  shells = [],
  selectedJobId,
  selectedAgentId,
  isActive = false,
  onSelect,
  onOpen,
  onClose,
  onCancel,
  onStopOrDismiss,
  width = 80,
  reducedMotion = false,
  screenReader = false,
}: {
  agents: AgentSummary[];
  shells?: BackgroundShellRecord[];
  selectedJobId?: string;
  selectedAgentId?: string;
  isActive?: boolean;
  onSelect?: (id?: string) => void;
  onOpen?: (id: string) => void;
  onClose?: () => void;
  onCancel?: () => void;
  onStopOrDismiss?: (id: string) => void;
  width?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex, currentIndex] = useKeyState(0);
  const orderedAgents = useMemo(
    () =>
      [...agents].sort((left, right) => {
        const terminal = (status: AgentSummary['status']) =>
          ['completed', 'failed', 'stopped', 'interrupted'].includes(status);
        const leftTerminal = terminal(left.status);
        const rightTerminal = terminal(right.status);
        if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
        return right.updatedAt - left.updatedAt;
      }),
    [agents],
  );
  const orderedShells = useMemo(
    () =>
      [...shells].sort((left, right) => {
        const terminal = (status: BackgroundShellRecord['status']) =>
          ['exited', 'failed', 'killed', 'timed_out', 'lost'].includes(status);
        const leftTerminal = terminal(left.status);
        const rightTerminal = terminal(right.status);
        if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
        return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
      }),
    [shells],
  );
  const jobs = useMemo(
    () => [
      ...orderedAgents.map((agent) => ({ id: agent.agentId, kind: 'agent' as const, agent })),
      ...orderedShells.map((shell) => ({ id: shell.id, kind: 'shell' as const, shell })),
    ],
    [orderedAgents, orderedShells],
  );
  const rows = useMemo(() => [undefined, ...jobs.map((job) => job.id)], [jobs]);
  useEffect(() => {
    const selected = selectedJobId ?? selectedAgentId;
    const next = selected ? rows.indexOf(selected) : 0;
    const resolved = next >= 0 ? next : 0;
    setSelectedIndex(resolved);
  }, [rows, selectedAgentId, selectedJobId, setSelectedIndex]);
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (key.escape) return onCancel?.();
      if (key.upArrow) {
        const next = (currentIndex() - 1 + rows.length) % rows.length;
        setSelectedIndex(next);
        onSelect?.(rows[next]);
      } else if (key.downArrow || key.tab) {
        const next = (currentIndex() + 1) % rows.length;
        setSelectedIndex(next);
        onSelect?.(rows[next]);
      } else if (key.return) {
        const id = rows[currentIndex()];
        if (id) onOpen?.(id);
        else onClose?.();
      } else if (input === 'x') {
        const id = rows[currentIndex()];
        if (id) onStopOrDismiss?.(id);
      }
    },
    { isActive },
  );
  const tiny = width < 42;
  const maxVisible = 5;
  // Keep the focused agent inside the window so Tab-cycling never highlights a
  // row that has scrolled out of view.
  const selected = selectedJobId ?? selectedAgentId;
  const focusedAgentIndex = selected ? jobs.findIndex((job) => job.id === selected) : -1;
  const windowStart =
    focusedAgentIndex < 0
      ? 0
      : Math.min(
          Math.max(0, focusedAgentIndex - (maxVisible - 1)),
          Math.max(0, jobs.length - maxVisible),
        );
  const visible = tiny
    ? [jobs.find((job) => job.id === selected) ?? jobs[0]].filter(Boolean)
    : jobs.slice(windowStart, windowStart + maxVisible);
  const activeRowId = rows[selectedIndex];
  const selectedMain = activeRowId === undefined;
  if (jobs.length === 0 && !isActive) return null;
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box paddingLeft={CONTENT_COLUMN}>
        <Text color={theme.brand} bold>
          Background tasks
        </Text>
      </Box>
      <Box>
        <Text color={selectedMain ? theme.text : theme.subtle} bold={selectedMain}>
          {selectedMain ? '› ' : '  '}● main
        </Text>
        <Text color={theme.subtle}> current conversation</Text>
      </Box>
      {jobs.length === 0 ? (
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.subtle}>No background tasks.</Text>
        </Box>
      ) : null}
      {visible.map((job) =>
        job.kind === 'agent' ? (
          <SubagentRow
            key={job.id}
            agent={job.agent}
            selected={job.id === activeRowId}
            width={Math.max(20, width - 2)}
            reducedMotion={reducedMotion}
            screenReader={screenReader}
          />
        ) : (
          <BackgroundShellRow
            key={job.id}
            shell={job.shell}
            selected={job.id === activeRowId}
            width={Math.max(20, width - 2)}
            reducedMotion={reducedMotion}
            screenReader={screenReader}
          />
        ),
      )}
      {jobs.length > visible.length ? (
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.subtle}>+{jobs.length - visible.length} more tasks</Text>
        </Box>
      ) : null}
      <Box paddingLeft={CONTENT_COLUMN}>
        <Text color={theme.subtle}>
          {isActive
            ? 'Tab/↑↓ select · Enter open · x stop/dismiss · Esc cancel'
            : 'Tab switch job · /jobs manage'}
        </Text>
      </Box>
    </Box>
  );
}
