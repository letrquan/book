import { Box, Text } from 'ink';
import type { QueuedInput } from '../queued-inputs.js';
import { CONTENT_COLUMN } from '../layout.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';

/**
 * How a note above the composer reads. `warning` is for a state that needs
 * you (the exit window, a paused queue); `done` confirms something that just
 * happened, with a green check; `info` is a plain remark.
 */
export type NoticeTone = 'warning' | 'done' | 'info';

/** A note that fades on its own after a few seconds. */
export interface FlashNotice {
  text: string;
  tone: NoticeTone;
}

interface QueuedInputPreviewProps {
  /** Queued follow-ups, sent when the run ends. */
  items: readonly QueuedInput[];
  /** Steers waiting in the running loop, delivered at its next tool boundary (#661). */
  steers?: readonly QueuedInput[];
  terminalWidth: number;
  notice?: string;
  noticeTone?: NoticeTone;
}

/** Total rows the two sections show before the rest are counted as "... n more". */
const MAX_VISIBLE_ROWS = 3;

/**
 * What sits between the transcript and the composer: the follow-ups waiting for the turn to
 * end, the steers the running turn will take at its next tool call, and a one-line note. Quiet
 * grey on the content column, so it reads as margin matter; the rubric red belongs to marks.
 */
export function QueuedInputPreview({
  items,
  steers = [],
  terminalWidth,
  notice,
  noticeTone = 'warning',
}: QueuedInputPreviewProps) {
  const theme = useTheme();
  if (items.length === 0 && steers.length === 0 && !notice) return null;

  const width = Math.max(8, Math.floor(terminalWidth) - CONTENT_COLUMN - 4);
  // One budget across both sections, in the order they are delivered: a steer is still ahead of
  // the run's own end, so its rows come first.
  const visibleSteers = steers.slice(0, MAX_VISIBLE_ROWS);
  const visibleQueued = items.slice(0, Math.max(0, MAX_VISIBLE_ROWS - visibleSteers.length));
  const hidden = steers.length + items.length - visibleSteers.length - visibleQueued.length;

  const rows = (entries: readonly QueuedInput[]) =>
    entries.map((item) => (
      <Text key={item.id} color={theme.inactive}>
        {'  ↳ '}
        {item.attachments?.length
          ? `[${item.attachments.length} image${item.attachments.length === 1 ? '' : 's'}] `
          : ''}
        {truncateDisplay(item.value.replace(/\s+/g, ' ').trim(), width)}
      </Text>
    ));

  return (
    <Box flexDirection="column" paddingLeft={CONTENT_COLUMN} marginBottom={1}>
      {steers.length > 0 ? (
        <>
          <Text color={theme.subtle}>Sends after the current tool call ({steers.length})</Text>
          {rows(visibleSteers)}
        </>
      ) : null}
      {items.length > 0 ? (
        <>
          <Text color={theme.subtle}>Queued for when this run ends ({items.length})</Text>
          {rows(visibleQueued)}
        </>
      ) : null}
      {hidden > 0 ? <Text color={theme.inactive}> ... {hidden} more</Text> : null}
      {notice ? (
        noticeTone === 'done' ? (
          <Text>
            <Text color={theme.success}>✓ </Text>
            <Text color={theme.subtle}>{truncateDisplay(notice, width + 2)}</Text>
          </Text>
        ) : (
          <Text color={noticeTone === 'info' ? theme.subtle : theme.warning}>
            {truncateDisplay(notice, width + 4)}
          </Text>
        )
      ) : null}
    </Box>
  );
}
