import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary } from '../../agents/types.js';
import { useTheme } from '../theme.js';
import { SubagentRow } from './SubagentRow.js';

export function SubagentPanel({
  agents,
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
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
  const rows = useMemo(
    () => [undefined, ...orderedAgents.map((agent) => agent.agentId)],
    [orderedAgents],
  );
  useEffect(() => {
    const next = selectedAgentId ? rows.indexOf(selectedAgentId) : 0;
    const resolved = next >= 0 ? next : 0;
    selectedIndexRef.current = resolved;
    setSelectedIndex(resolved);
  }, [rows, selectedAgentId]);
  useInput(
    (input, key) => {
      if (!isActive) return;
      if (key.escape) return onCancel?.();
      if (key.upArrow) {
        const next = (selectedIndexRef.current - 1 + rows.length) % rows.length;
        selectedIndexRef.current = next;
        setSelectedIndex(next);
        onSelect?.(rows[next]);
      } else if (key.downArrow || key.tab) {
        const next = (selectedIndexRef.current + 1) % rows.length;
        selectedIndexRef.current = next;
        setSelectedIndex(next);
        onSelect?.(rows[next]);
      } else if (key.return) {
        const id = rows[selectedIndexRef.current];
        if (id) onOpen?.(id);
        else onClose?.();
      } else if (input === 'x') {
        const id = rows[selectedIndexRef.current];
        if (id) onStopOrDismiss?.(id);
      }
    },
    { isActive },
  );
  const tiny = width < 42;
  const maxVisible = 5;
  // Keep the focused agent inside the window so Tab-cycling never highlights a
  // row that has scrolled out of view.
  const focusedAgentIndex = selectedAgentId
    ? orderedAgents.findIndex((agent) => agent.agentId === selectedAgentId)
    : -1;
  const windowStart =
    focusedAgentIndex < 0
      ? 0
      : Math.min(
          Math.max(0, focusedAgentIndex - (maxVisible - 1)),
          Math.max(0, orderedAgents.length - maxVisible),
        );
  const visible = tiny
    ? [orderedAgents.find((agent) => agent.agentId === selectedAgentId) ?? orderedAgents[0]].filter(
        (agent): agent is AgentSummary => Boolean(agent),
      )
    : orderedAgents.slice(windowStart, windowStart + maxVisible);
  const activeRowId = rows[selectedIndex];
  const selectedMain = activeRowId === undefined;
  if (agents.length === 0 && !isActive) return null;
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text color={theme.brand} bold>
        Background tasks
      </Text>
      <Box>
        <Text color={selectedMain ? theme.text : theme.subtle} bold={selectedMain}>
          {' '}
          {selectedMain ? '›' : ' '} ● main
        </Text>
        <Text color={theme.subtle}> current conversation</Text>
      </Box>
      {agents.length === 0 ? <Text color={theme.subtle}> No background tasks.</Text> : null}
      {visible.map((agent) => (
        <SubagentRow
          key={agent.agentId}
          agent={agent}
          selected={agent.agentId === activeRowId}
          width={Math.max(20, width - 2)}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
        />
      ))}
      {agents.length > visible.length ? (
        <Text color={theme.subtle}> +{agents.length - visible.length} more tasks</Text>
      ) : null}
      <Text color={theme.subtle}>
        {isActive
          ? ' Tab/↑↓ select · Enter open · x stop/dismiss · Esc cancel'
          : ' Tab switch agent · /tasks manage'}
      </Text>
    </Box>
  );
}
