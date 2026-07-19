import { Text } from 'ink';
import { useMemo } from 'react';
import { usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { FileMentionCandidate } from '../file-mentions.js';
import { truncateDisplay } from './word-wrap.js';
import { getCommandMenuWindow } from './CommandMenu.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';

interface FileMentionMenuProps {
  items: FileMentionCandidate[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
  terminalWidth?: number;
  maxRows?: number;
  compact?: boolean;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function formatFileRow(
  item: FileMentionCandidate,
  selected: boolean,
  width: number,
  compact: boolean,
  shimmer: boolean,
  screenReader: boolean,
): string {
  const marker = screenReader
    ? selected
      ? 'selected '
      : ''
    : selected
      ? shimmer
        ? '▸ '
        : '› '
      : '  ';
  const badge =
    item.kind === 'directory' ? (compact ? ' [D]' : ' [Directory]') : compact ? ' [F]' : ' [File]';
  const desc = item.desc && !compact ? ` — ${item.desc}` : '';
  return truncateDisplay(`${marker}@${item.path}${badge}${desc}`, width);
}

/** Workspace file picker for @ mentions. */
export function FileMentionMenu({
  items,
  filterText,
  selectedIndex,
  visible,
  terminalWidth = 80,
  maxRows = 8,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: FileMentionMenuProps) {
  const theme = useTheme();
  const shimmer = usePulse(visible && !reducedMotion && !screenReader, 360);

  const width = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(width);
  const contentWidth = Math.max(8, frame.width - 4);
  const safeMaxRows = Math.max(1, Math.floor(maxRows));
  const selIdx = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const window = useMemo(
    () => getCommandMenuWindow(items.length, selIdx, safeMaxRows),
    [items.length, selIdx, safeMaxRows],
  );
  const visibleItems = items.slice(window.start, window.end);
  const hiddenTotal = window.start + Math.max(0, items.length - window.end);

  if (!visible) return null;

  const title = filterText
    ? truncateDisplay(`Files matching “${filterText}”`, contentWidth)
    : 'Files';

  return (
    <SoftPanel width={frame.width} marginX={frame.marginX}>
      <PanelTitle>{title}</PanelTitle>

      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>
          No matching files
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const globalIndex = window.start + index;
          const isSelected = globalIndex === selIdx;
          return (
            <SelectionRow
              key={`${item.kind}-${item.path}-${globalIndex}`}
              selected={isSelected}
              width={contentWidth}
            >
              {formatFileRow(item, isSelected, contentWidth, compact, shimmer, screenReader)}
            </SelectionRow>
          );
        })
      )}

      {hiddenTotal > 0 ? (
        <Text color={theme.subtle} dimColor>
          {truncateDisplay(`… ${hiddenTotal} more, type to filter`, contentWidth)}
        </Text>
      ) : null}
    </SoftPanel>
  );
}
