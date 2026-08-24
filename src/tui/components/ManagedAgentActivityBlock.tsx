import { Box, Text } from 'ink';
import { useUiClock } from '../ui-clock.js';
import type { ManagedAgentTrace, ManagedAgentToolUse } from '../managed-agent-transcript.js';
import { formatDuration, deriveToolPresentation } from '../tool-presentation.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { truncateDisplay } from './word-wrap.js';
import { Spinner } from './Spinner.js';

const MAX_VISIBLE_TOOL_USES = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function useCurrentTime(active: boolean): number {
  const tick = useUiClock('slow', active);
  void tick;
  return Date.now();
}

function statusGlyph(status: ManagedAgentToolUse['status'] | ManagedAgentTrace['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✕';
  if (status === 'stopped' || status === 'interrupted') return '■';
  return '›';
}

function resultPreview(tool: ManagedAgentToolUse): string | undefined {
  const content =
    tool.result?.structuredError?.message ||
    tool.result?.presentation?.details ||
    tool.result?.content;
  if (!content) return undefined;
  const line = content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? truncateDisplay(line, 72) : undefined;
}

function durationFor(trace: ManagedAgentTrace, now: number): string | undefined {
  const end = trace.finishedAt ?? now;
  return formatDuration(Math.max(0, end - trace.startedAt));
}

function toolDuration(tool: ManagedAgentToolUse): string | undefined {
  if (!tool.finishedAt) return undefined;
  return formatDuration(Math.max(0, tool.finishedAt - tool.startedAt));
}

export function ManagedAgentActivityBlock({
  trace,
  reducedMotion = false,
  screenReader = false,
  terminalWidth = 80,
}: {
  trace: ManagedAgentTrace;
  reducedMotion?: boolean;
  screenReader?: boolean;
  terminalWidth?: number;
}) {
  const theme = useTheme();
  const terminal = TERMINAL_STATUSES.has(trace.status);
  const now = useCurrentTime(!terminal);
  const elapsed = durationFor(trace, now);
  const visible = trace.toolUses.slice(-MAX_VISIBLE_TOOL_USES);
  const hiddenCount = Math.max(0, trace.toolUses.length - visible.length);
  const grid = transcriptGrid(terminalWidth);
  const width = grid.content;

  if (screenReader) {
    return (
      <Box flexDirection="column" marginLeft={2} width={width}>
        <Text>
          Subagent {trace.profile}, {trace.purpose}. Status {trace.status}.{' '}
          {elapsed ? `Elapsed ${elapsed}.` : ''}
        </Text>
        {visible.map((tool) => {
          const presentation = deriveToolPresentation(
            tool.call.name,
            tool.call.arguments,
            tool.result,
          );
          return (
            <Text key={tool.id}>
              {presentation.summary}. {tool.status}. {resultPreview(tool) ?? ''}
            </Text>
          );
        })}
        {hiddenCount > 0 ? <Text>{hiddenCount} earlier tool uses hidden.</Text> : null}
        <Text>Press Tab to open the complete subagent transcript.</Text>
      </Box>
    );
  }

  const headerColor =
    trace.status === 'failed'
      ? theme.error
      : trace.status === 'completed'
        ? theme.success
        : trace.status === 'stopped' || trace.status === 'interrupted'
          ? theme.warning
          : theme.brand;
  return (
    <Box flexDirection="column" width={grid.width}>
      <Box>
        {terminal ? (
          <Text color={headerColor}>{statusGlyph(trace.status)} </Text>
        ) : (
          <Spinner active color={theme.assistantAccent} reducedMotion={reducedMotion} />
        )}
        <Text color={headerColor} bold>
          {trace.profile}
        </Text>
        <Text color={theme.text}>
          ({truncateDisplay(trace.purpose, Math.max(12, width - trace.profile.length - 18))})
        </Text>
        {elapsed ? <Text color={theme.subtle}> · {elapsed}</Text> : null}
      </Box>

      {visible.map((tool, index) => {
        const presentation = deriveToolPresentation(
          tool.call.name,
          tool.call.arguments,
          tool.result,
        );
        const running = tool.status === 'running';
        const connector = index === visible.length - 1 ? '└' : '├';
        const color = tool.status === 'failed' ? theme.error : running ? theme.brand : theme.text;
        const duration = toolDuration(tool);
        return (
          <Box key={tool.id} flexDirection="column" marginLeft={CONTENT_COLUMN}>
            <Box>
              <Text color={theme.toolRail}>{connector} </Text>
              {running ? (
                <Spinner active color={theme.assistantAccent} reducedMotion={reducedMotion} />
              ) : (
                <Text color={color}>{statusGlyph(tool.status)} </Text>
              )}
              <Text color={color}>
                {truncateDisplay(presentation.summary, Math.max(12, width - 8))}
              </Text>
              {duration ? <Text color={theme.subtle}> · {duration}</Text> : null}
            </Box>
            {resultPreview(tool) ? (
              <Text color={theme.subtle} dimColor>
                {'    '}└ {resultPreview(tool)}
              </Text>
            ) : null}
          </Box>
        );
      })}

      {hiddenCount > 0 ? (
        <Text color={theme.subtle}>
          {'  '}… +{hiddenCount} tool {hiddenCount === 1 ? 'use' : 'uses'}
        </Text>
      ) : null}
      <Text color={theme.subtle} dimColor>
        {'  '}
        {terminal ? 'Transcript retained · Tab to open' : 'Running in background · Tab to open'}
      </Text>
    </Box>
  );
}
