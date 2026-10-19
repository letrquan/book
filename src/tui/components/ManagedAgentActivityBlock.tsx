import { Box, Text } from 'ink';
import React from 'react';
import { useUiClock } from '../ui-clock.js';
import type { ManagedAgentTrace, ManagedAgentToolUse } from '../managed-agent-transcript.js';
import {
  composeToolHeading,
  deriveToolPresentation,
  formatDuration,
} from '../tool-presentation.js';
import { useTheme } from '../theme.js';
import { useMemoryRoot } from '../memory-root.js';
import { GUTTER_WIDTH, resultContentWidth, transcriptGrid } from '../layout.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { ItemMark, ResultBox, ResultLine, type ItemState } from './transcript-item.js';

const MAX_VISIBLE_TOOL_USES = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function useCurrentTime(active: boolean): number {
  const tick = useUiClock('slow', active);
  void tick;
  return Date.now();
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
  const memoryRoot = useMemoryRoot();
  const terminal = TERMINAL_STATUSES.has(trace.status);
  const now = useCurrentTime(!terminal);
  const elapsed = durationFor(trace, now);
  const visible = trace.toolUses.slice(-MAX_VISIBLE_TOOL_USES);
  const hiddenCount = Math.max(0, trace.toolUses.length - visible.length);
  // A blocked lead is a different situation from a background spawn and reads
  // wrong under the same words: "Running in background" next to a stopped parent
  // tells the user work is proceeding alongside their turn when nothing is.
  // Tab opens a child only while it still has a Background-panel row.
  const tabHint = trace.openable === false ? '' : ' · Tab to open';
  const footer = terminal
    ? `Transcript retained${tabHint}`
    : trace.blocking
      ? `Lead paused · sidekick working${tabHint}`
      : `Running in background${tabHint}`;
  // While it runs, the footer says for how long; a finished block's time is no news.
  const footerLine =
    terminal || !elapsed
      ? footer
      : [
          trace.blocking ? 'Lead paused · sidekick working' : 'Running in background',
          elapsed,
          ...(trace.openable === false ? [] : ['Tab to open']),
        ].join(' · ');
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
            { unparsedArguments: tool.call.unparsedArguments, memoryRoot },
          );
          return (
            <Text key={tool.id}>
              {presentation.summary}. {tool.status}. {resultPreview(tool) ?? ''}
            </Text>
          );
        })}
        {hiddenCount > 0 ? <Text>{hiddenCount} earlier tool uses hidden.</Text> : null}
        <Text>{footer}.</Text>
        {trace.openable === false ? null : (
          <Text>Press Tab to open the complete subagent transcript.</Text>
        )}
      </Box>
    );
  }

  const markState: ItemState =
    trace.status === 'failed'
      ? 'failure'
      : trace.status === 'completed'
        ? 'success'
        : trace.status === 'stopped' || trace.status === 'interrupted'
          ? 'skipped'
          : 'running';
  // The block is an item like a call: the agent's profile is its name, the purpose its
  // argument, and what it has been doing hangs under `⎿`. Time shows only while it runs.
  const resultWidth = resultContentWidth(grid);
  const purposeRoom = Math.max(4, grid.content - displayWidth(trace.profile) - 2);
  return (
    <Box flexDirection="column" width={grid.content + GUTTER_WIDTH}>
      <Box height={1}>
        <ItemMark state={markState} reducedMotion={reducedMotion} />
        <Text wrap="truncate-end" bold color={theme.text}>
          {trace.profile}
        </Text>
        <Text color={theme.inactive}>(</Text>
        <Text color={theme.subtle}>{truncateDisplay(trace.purpose, purposeRoom)}</Text>
        <Text color={theme.inactive}>)</Text>
      </Box>
      <ResultBox width={resultWidth}>
        {hiddenCount > 0 ? (
          <ResultLine
            text={`… +${hiddenCount} tool ${hiddenCount === 1 ? 'use' : 'uses'}`}
            color={theme.inactive}
          />
        ) : null}
        {visible.map((tool) => {
          const presentation = deriveToolPresentation(
            tool.call.name,
            tool.call.arguments,
            tool.result,
            { unparsedArguments: tool.call.unparsedArguments, memoryRoot },
          );
          const heading = composeToolHeading(presentation, resultWidth);
          const preview = tool.status === 'failed' ? resultPreview(tool) : undefined;
          return (
            <React.Fragment key={tool.id}>
              <ResultLine
                text={heading.target ? `${heading.name}(${heading.target})` : heading.name}
                color={tool.status === 'failed' ? theme.error : theme.subtle}
              />
              {preview ? <ResultLine text={preview} color={theme.error} /> : null}
            </React.Fragment>
          );
        })}
        <ResultLine text={footerLine} color={theme.inactive} />
      </ResultBox>
    </Box>
  );
}
