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
  tone: Exclude<NoticeTone, 'warning'>;
}

interface QueuedInputPreviewProps {
  items: readonly QueuedInput[];
  terminalWidth: number;
  notice?: string;
  noticeTone?: NoticeTone;
}

/**
 * What sits between the transcript and the composer: follow-ups waiting for
 * the turn to end, and a one-line note. Quiet grey on the content column, so
 * it reads as margin matter; the rubric red belongs to marks.
 */
export function QueuedInputPreview({
  items,
  terminalWidth,
  notice,
  noticeTone = 'warning',
}: QueuedInputPreviewProps) {
  const theme = useTheme();
  if (items.length === 0 && !notice) return null;

  const width = Math.max(8, Math.floor(terminalWidth) - CONTENT_COLUMN - 4);
  const visible = items.slice(0, 3);
  const hidden = items.length - visible.length;

  return (
    <Box flexDirection="column" paddingLeft={CONTENT_COLUMN} marginBottom={1}>
      {items.length > 0 ? (
        <Text color={theme.subtle}>Queued follow-up inputs ({items.length})</Text>
      ) : null}
      {visible.map((item) => (
        <Text key={item.id} color={theme.inactive}>
          {'  ↳ '}
          {item.attachments?.length
            ? `[${item.attachments.length} image${item.attachments.length === 1 ? '' : 's'}] `
            : ''}
          {truncateDisplay(item.value.replace(/\s+/g, ' ').trim(), width)}
        </Text>
      ))}
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
