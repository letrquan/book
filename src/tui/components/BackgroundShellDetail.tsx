import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import { useTheme } from '../theme.js';
import { useUiClock } from '../ui-clock.js';
import { formatElapsedDuration } from './SubagentRow.js';

/** Live-output poll cadence. Reading the tail can hit the filesystem for
 * persistent jobs, so it must happen in an effect, never during render. */
const OUTPUT_POLL_MS = 250;

function sanitizeOutput(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|$)/g, '');
}

export function BackgroundShellDetail({
  shell,
  readTail,
  width,
}: {
  shell: BackgroundShellRecord;
  /** Stable callback returning the current output tail for this shell. */
  readTail: () => string;
  width: number;
}) {
  const theme = useTheme();
  const running = shell.finishedAt === undefined;
  useUiClock('slow', running);
  const [output, setOutput] = useState(readTail);
  useEffect(() => {
    setOutput(readTail());
    if (!running) return;
    const timer = setInterval(() => setOutput(readTail()), OUTPUT_POLL_MS);
    return () => clearInterval(timer);
  }, [readTail, running]);
  const elapsed = Math.max(
    0,
    Math.floor(((shell.finishedAt ?? Date.now()) - shell.startedAt) / 1000),
  );
  const exit = shell.exitCode !== undefined ? ` | exit ${shell.exitCode ?? 'none'}` : '';
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text color={theme.brand} bold>
        main &gt; {shell.title || shell.command}
      </Text>
      <Text color={theme.subtle}>
        shell | {shell.status} | {shell.lifetime ?? 'session'} | {formatElapsedDuration(elapsed)}
        {exit}
      </Text>
      <Text color={theme.subtle}>
        pid {shell.pid ?? 'unknown'} | {shell.sandboxed ? 'sandboxed' : 'unsandboxed'} | notify{' '}
        {shell.notify ?? 'ui'}
      </Text>
      <Text color={theme.subtle}>cwd {shell.workdir}</Text>
      <Text>{shell.command}</Text>
      {shell.truncatedBytes > 0 ? (
        <Text color={theme.warning}>
          {shell.truncatedBytes} older output characters were truncated.
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.subtle}>Output tail</Text>
        <Text>{sanitizeOutput(output) || '(no output yet)'}</Text>
      </Box>
      <Text color={theme.subtle}>Tab switch | x stop/dismiss | Esc main | /jobs list</Text>
    </Box>
  );
}
