import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { LocalCommandDisplay } from '../../types/messages.js';
import { panelContentWidth, panelGrid } from '../layout.js';
import { useTheme } from '../theme.js';
import { SoftPanel } from './chrome.js';
import { CommandPanel } from './CommandPanel.js';
import { DiffBlock, isUnifiedDiffLike, parseDiffLines } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';

/**
 * What a lookup command (`/context`, `/cost`, `/diff`, …) shows in the reference-sheet slot.
 *
 * A lookup answers a question about the session as it stands, and its figures are stale by the
 * next turn, so it is a sheet Esc or the next prompt closes rather than a transcript entry that
 * scrolls with the conversation and is replayed on resume.
 */
export interface ReportSheetContent {
  title: string;
  /** The report as text: a text sheet's body, and a figure sheet's screen-reader form. */
  content: string;
  /** Figures `CommandPanel` lays out (`/context`, `/usage`). */
  display?: LocalCommandDisplay;
}

export const REPORT_SHEET_CLOSE_HINT = 'Esc to close';

/** `2 files · +12 −4`, said at the foot of a diff sheet, which is the part a long diff shows. */
export function diffSummary(output: string): string {
  const files = output.split('\n').filter((line) => line.startsWith('diff --git ')).length;
  let added = 0;
  let removed = 0;
  for (const line of parseDiffLines(output)) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }
  const fileCount = files > 0 ? `${files} ${files === 1 ? 'file' : 'files'} · ` : '';
  return `${fileCount}+${added} −${removed}`;
}

export function ReportSheet({
  sheet,
  terminalWidth,
  reducedMotion = false,
  screenReader = false,
}: {
  sheet: ReportSheetContent;
  terminalWidth: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const isDiff = useMemo(() => isUnifiedDiffLike(sheet.content), [sheet.content]);
  const summary = useMemo(
    () => (isDiff ? diffSummary(sheet.content) : undefined),
    [isDiff, sheet.content],
  );

  if (sheet.display && !screenReader) {
    // `CommandPanel` heads itself with the same rule a sheet has, and keeps no top margin of its
    // own because the transcript spaces its entries. For a screen reader it drops that head, so
    // the sheet below carries the title and the close hint instead.
    return (
      <Box marginTop={1}>
        <CommandPanel
          display={sheet.display}
          fallback={sheet.content}
          meta={REPORT_SHEET_CLOSE_HINT}
          terminalWidth={terminalWidth}
          reducedMotion={reducedMotion}
          screenReader={screenReader}
        />
      </Box>
    );
  }

  const contentWidth = panelContentWidth(terminalWidth);
  return (
    <SoftPanel
      title={sheet.title}
      meta={REPORT_SHEET_CLOSE_HINT}
      width={panelGrid(terminalWidth).width}
    >
      {isDiff ? (
        <Box flexDirection="column">
          <DiffBlock output={sheet.content} terminalWidth={contentWidth} />
          <Text color={theme.inactive}>
            {summary} · {REPORT_SHEET_CLOSE_HINT}
          </Text>
        </Box>
      ) : sheet.display ? (
        <Text>{sheet.content}</Text>
      ) : (
        <MarkdownBlock content={sheet.content} terminalWidth={contentWidth} />
      )}
    </SoftPanel>
  );
}
