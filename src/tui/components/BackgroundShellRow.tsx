import { Text } from 'ink';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import { useTheme } from '../theme.js';
import { useUiClock } from '../ui-clock.js';
import { formatElapsedDuration } from './SubagentRow.js';
import { truncateDisplay } from './word-wrap.js';

function glyph(shell: BackgroundShellRecord, reducedMotion: boolean): string {
  if (shell.status === 'exited') return '✓';
  if (shell.status === 'failed' || shell.status === 'timed_out' || shell.status === 'lost')
    return '✕';
  if (shell.status === 'killed') return '■';
  return reducedMotion ? '*' : '●';
}

export function BackgroundShellRow({
  shell,
  selected = false,
  width = 80,
  reducedMotion = false,
  screenReader = false,
}: {
  shell: BackgroundShellRecord;
  selected?: boolean;
  width?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const terminal = ['exited', 'failed', 'killed', 'timed_out', 'lost'].includes(shell.status);
  const tick = useUiClock('slow', !terminal);
  void tick;
  const elapsed = Math.max(
    0,
    Math.floor(((shell.finishedAt ?? Date.now()) - shell.startedAt) / 1000),
  );
  const unread =
    (shell.completionSequence ?? 0) > (shell.completionAcknowledgedSequence ?? 0) ? ' !' : '';
  const lifetime = shell.lifetime === 'persistent' ? ' | persistent' : '';
  const suffix = ` | ${formatElapsedDuration(elapsed)}${lifetime}${unread}`;
  const title = shell.title || shell.command;
  const color =
    shell.status === 'exited'
      ? theme.success
      : shell.status === 'failed' || shell.status === 'timed_out' || shell.status === 'lost'
        ? theme.error
        : theme.brand;

  if (screenReader) {
    return (
      <Text>
        {title}. shell. {shell.status}. {formatElapsedDuration(elapsed)}.
      </Text>
    );
  }

  return (
    <Text color={selected ? theme.text : color} bold={selected}>
      {selected ? '› ' : '  '}
      {glyph(shell, reducedMotion)} shell{' '}
      {truncateDisplay(title, Math.max(1, width - 11 - suffix.length))}
      <Text color={theme.subtle}>{suffix}</Text>
    </Text>
  );
}
