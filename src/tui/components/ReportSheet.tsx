import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { LocalCommandDisplay } from '../../types/messages.js';
import { panelContentWidth } from '../layout.js';
import { useTheme } from '../theme.js';
import { CommandPanel } from './CommandPanel.js';
import { DiffBlock, isUnifiedDiffLike, parseDiffLines } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';

/**
 * What a lookup command (`/context`, `/cost`, `/diff`, …) shows in the dialog.
 *
 * A lookup answers a question about the session as it stands, and its figures are stale by the
 * next turn, so it is a dialog Esc closes rather than a transcript entry that scrolls with the
 * conversation and is replayed on resume.
 */
export interface ReportSheetContent {
  title: string;
  /** The report as text: a text report's body, and a figure report's screen-reader form. */
  content: string;
  /** Figures `CommandPanel` lays out (`/context`, `/usage`). */
  display?: LocalCommandDisplay;
}

/** `2 files · +12 −4`, said over a diff the way Claude Code's diff dialog heads its own. */
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

/** A lookup's report as the dialog's body: the dialog carries the title and the keys. */
export function ReportBody({
  sheet,
  terminalWidth,
  screenReader = false,
}: {
  sheet: ReportSheetContent;
  terminalWidth: number;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const isDiff = useMemo(() => isUnifiedDiffLike(sheet.content), [sheet.content]);
  const summary = useMemo(
    () => (isDiff ? diffSummary(sheet.content) : undefined),
    [isDiff, sheet.content],
  );
  const contentWidth = panelContentWidth(terminalWidth);

  if (sheet.display && !screenReader) {
    // No staggered reveal: the dialog measures its body to know when to scroll, and a body that
    // grows row by row under the measurement would be cut short.
    return (
      <CommandPanel
        display={sheet.display}
        fallback={sheet.content}
        terminalWidth={terminalWidth}
        reducedMotion
        bare
      />
    );
  }
  if (isDiff) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.inactive}>{summary}</Text>
        <DiffBlock output={sheet.content} terminalWidth={contentWidth} />
      </Box>
    );
  }
  if (sheet.display) return <Text>{sheet.content}</Text>;
  return <MarkdownBlock content={sheet.content} terminalWidth={contentWidth} />;
}
