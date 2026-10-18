import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { resultContentWidth, type TranscriptGrid } from '../layout.js';
import { quietRunFiles, quietRunHeading, type QuietRunSummary } from '../quiet-tools.js';
import { foldControlCharacters } from '../../control-characters.js';
import { truncateDisplay } from './word-wrap.js';
import { ItemMark, ResultBox, ResultLine } from './transcript-item.js';

/**
 * One item standing in for a run of quiet tool calls (reads, searches, lookups).
 *
 * It is drawn as the calls it stands for, `Search(memory), Read(4 files)`, under the same
 * mark as any other call, in grey: nothing here changed anything. When it read several files
 * the result row names them. The calls it replaces come back with Ctrl+O.
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
  const heading = quietRunHeading(summary);

  if (screenReader) {
    return (
      <Box>
        <Text>
          {foldControlCharacters(
            `${summary.title} ${summary.target} (${summary.metadata.join(', ')})`,
          )}
        </Text>
      </Box>
    );
  }

  const width = resultContentWidth(grid);
  return (
    <Box flexDirection="column">
      {/* The heading is one line by contract; it must truncate, never wrap, because a wrapped line is drawn outside the box and the render cull relies on rows drawing inside their own box. */}
      <Box height={1}>
        <ItemMark state={summary.running ? 'running' : 'quiet'} reducedMotion={reducedMotion} />
        <Text wrap="truncate-end" color={theme.subtle}>
          {truncateDisplay(heading, Math.max(1, grid.content))}
        </Text>
      </Box>
      {summary.files.length > 1 ? (
        <ResultBox width={width}>
          <ResultLine text={quietRunFiles(summary)} color={theme.inactive} />
        </ResultBox>
      ) : null}
    </Box>
  );
}

export const QuietToolRun = React.memo(QuietToolRunInner);
