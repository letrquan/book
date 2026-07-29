import { Text } from 'ink';
import type { AgentSummary } from '../../agents/types.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';
import { useUiClock } from '../ui-clock.js';

function statusGlyph(status: AgentSummary['status'], reducedMotion: boolean): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✕';
  if (status === 'stopped' || status === 'interrupted') return '■';
  if (status === 'waiting_input' || status === 'waiting_permission') return '?';
  return reducedMotion ? '*' : '●';
}

function terminalActivity(agent: AgentSummary): string {
  if (agent.status === 'completed') return agent.summary?.split(/\r?\n/, 1)[0] ?? 'Completed';
  if (agent.status === 'failed') return agent.error?.split(/\r?\n/, 1)[0] ?? 'Failed';
  if (agent.status === 'stopped') return 'Stopped';
  if (agent.status === 'interrupted') return 'Interrupted';
  return agent.currentActivity?.label ?? agent.status.replace('_', ' ');
}

export function formatElapsedDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

function useCurrentTime(active: boolean, fixedNow?: number): number {
  const tick = useUiClock('slow', active && fixedNow === undefined);
  void tick;
  return fixedNow ?? Date.now();
}

export function SubagentRow({
  agent,
  selected = false,
  width = 80,
  reducedMotion = false,
  screenReader = false,
  now,
}: {
  agent: AgentSummary;
  selected?: boolean;
  width?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  now?: number;
}) {
  const theme = useTheme();
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(agent.status);
  const currentTime = useCurrentTime(!terminal, now);
  const activity = terminal
    ? terminalActivity(agent)
    : (agent.currentActivity?.label ?? agent.status.replace('_', ' '));
  const elapsed = Math.max(
    0,
    Math.floor(((agent.finishedAt ?? currentTime) - (agent.startedAt ?? agent.createdAt)) / 1000),
  );
  const color =
    agent.status === 'failed'
      ? theme.error
      : agent.status === 'completed'
        ? theme.success
        : agent.status === 'waiting_input' || agent.status === 'waiting_permission'
          ? theme.warning
          : theme.brand;

  if (screenReader) {
    return (
      <Text>
        {agent.displayName}. {agent.profile}. {agent.resolvedModel}. {agent.status}. {activity}.
      </Text>
    );
  }

  const elapsedLabel = formatElapsedDuration(elapsed);
  const elapsedSuffix = ` | ${elapsedLabel}`;
  const displayNameWidth = Math.max(1, width - 8 - elapsedSuffix.length);
  return (
    <Text color={selected ? theme.text : color} bold={selected}>
      {' '}
      {selected ? '›' : ' '} {statusGlyph(agent.status, reducedMotion)}{' '}
      {truncateDisplay(agent.displayName, displayNameWidth)}
      <Text color={theme.subtle}>{elapsedSuffix}</Text>
    </Text>
  );
}
