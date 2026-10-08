import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, type TranscriptGrid } from '../layout.js';
import { composeToolRow } from '../tool-presentation.js';
import type { QuietRunSummary } from '../quiet-tools.js';
import { Spinner } from './Spinner.js';
import { MetaText, TargetText } from './ToolCallBlock.js';

/**
 * One row standing in for a run of quiet tool calls (reads, searches, lookups).
 *
 * It sits on the same indented grid as the tool rows around it, so its verb,
 * target and counts line up with theirs, and it is drawn a step quieter: the
 * check is grey rather than green, because nothing here changed anything. The
 * rows it replaces come back with Ctrl+O.
 */
function QuietToolRunInner({
  summary,
  grid,
  reducedMotion = false,
  screenReader = false,
}: {
  summary: QuietRunSummary;
  grid: TranscriptGrid;
  reducedMotion?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const row = composeToolRow(
    { title: summary.title, target: summary.target, metadata: summary.metadata },
    grid,
  );

  if (screenReader) {
    return (
      <Box>
        <Text>
          {summary.title} {summary.target} ({summary.metadata.join(', ')})
        </Text>
      </Box>
    );
  }

  return (
    <Box height={1} marginLeft={CONTENT_COLUMN}>
      {/* The row is one line by contract; it must truncate, never wrap, because a wrapped line is drawn outside the box and the render cull relies on rows drawing inside their own box. */}
      {summary.running ? (
        // Spinner emits its own trailing space, keeping the gutter two wide.
        <Spinner active style="dots" color={theme.assistantAccent} reducedMotion={reducedMotion} />
      ) : (
        <Text wrap="truncate-end" color={theme.inactive}>
          {'✓ '}
        </Text>
      )}
      {row.label ? (
        <Text wrap="truncate-end" color={theme.inactive}>
          {row.label}{' '}
        </Text>
      ) : null}
      <TargetText target={row.target} failed={false} wrap="truncate-end" />
      <Text wrap="truncate-end">{row.gap}</Text>
      <MetaText meta={row.meta} failed={false} wrap="truncate-end" />
    </Box>
  );
}

export const QuietToolRun = React.memo(QuietToolRunInner);
