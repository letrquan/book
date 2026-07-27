import { Box, Text } from 'ink';
import type { QueuedInput } from '../queued-inputs.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';

interface QueuedInputPreviewProps {
  items: readonly QueuedInput[];
  terminalWidth: number;
  notice?: string;
}

export function QueuedInputPreview({ items, terminalWidth, notice }: QueuedInputPreviewProps) {
  const theme = useTheme();
  if (items.length === 0 && !notice) return null;

  const width = Math.max(8, Math.floor(terminalWidth) - 6);
  const visible = items.slice(0, 3);
  const hidden = items.length - visible.length;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {items.length > 0 ? (
        <Text bold color={theme.brand}>
          Queued follow-up inputs ({items.length})
        </Text>
      ) : null}
      {visible.map((item) => (
        <Text key={item.id} color={theme.subtle}>
          {'  ↳ '}
          {item.attachments?.length
            ? `[${item.attachments.length} image${item.attachments.length === 1 ? '' : 's'}] `
            : ''}
          {truncateDisplay(item.value.replace(/\s+/g, ' ').trim(), width)}
        </Text>
      ))}
      {hidden > 0 ? <Text color={theme.inactive}> ... {hidden} more</Text> : null}
      {notice ? <Text color={theme.warning}>{truncateDisplay(notice, width + 4)}</Text> : null}
    </Box>
  );
}
