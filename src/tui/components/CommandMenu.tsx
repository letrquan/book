import { Text } from 'ink';
import { useMemo } from 'react';
import { usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { CommandItem } from '../../commands/filter.js';
import { truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';

const renderLog = createRenderDebugLogger('tui:cmdmenu');

interface CommandMenuProps {
  /** Pre-filtered and categorized command items to display. */
  items: CommandItem[];
  /** Current filter text (empty = show categorized sections). */
  filterText: string;
  /** Index of the currently selected item in the flattened list. */
  selectedIndex: number;
  /** Whether the menu is visible. */
  visible: boolean;
  /** Available width, excluding any parent padding. */
  terminalWidth?: number;
  /** Maximum command rows to render. */
  maxRows?: number;
  /** Compact rendering for narrow or short terminals. */
  compact?: boolean;
  /** Disable motion for accessibility. */
  reducedMotion?: boolean;
  /** Render plain, non-decorative output for screen readers. */
  screenReader?: boolean;
}

const CATEGORY_LABELS: Record<CommandItem['category'], string> = {
  recent: 'Recent',
  builtin: 'Built-in',
  user: 'User',
  project: 'Project',
};

const COMPACT_CATEGORY_LABELS: Record<CommandItem['category'], string> = {
  recent: 'R',
  builtin: 'B',
  user: 'U',
  project: 'P',
};

export function getCommandMenuWindow(
  itemCount: number,
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  const safeCount = Math.max(0, itemCount);
  const safeRows = Math.max(1, Math.floor(maxRows));
  if (safeCount <= safeRows) return { start: 0, end: safeCount };

  const selected = Math.max(0, Math.min(selectedIndex, safeCount - 1));
  const half = Math.floor(safeRows / 2);
  let start = Math.max(0, selected - half);
  start = Math.min(start, safeCount - safeRows);
  return { start, end: start + safeRows };
}

function formatCommandRow(
  item: CommandItem,
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
  const hint = item.hint ? ` ${item.hint}` : '';
  const category = compact
    ? COMPACT_CATEGORY_LABELS[item.category]
    : CATEGORY_LABELS[item.category];
  const badge = compact ? ` [${category}]` : ` [${category}]`;
  const desc = item.desc && !compact ? ` — ${item.desc}` : '';
  return truncateDisplay(`${marker}/${item.name}${hint}${badge}${desc}`, width);
}

/** Slash-command palette. Filtering/ranking lives in commands/filter.ts. */
export function CommandMenu({
  items,
  filterText,
  selectedIndex,
  visible,
  terminalWidth = 80,
  maxRows = 8,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: CommandMenuProps) {
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
  const hiddenBefore = window.start;
  const hiddenAfter = Math.max(0, items.length - window.end);
  const hiddenTotal = hiddenBefore + hiddenAfter;

  if (!visible) return null;

  renderLog.event('render', {
    items: items.length,
    visible: visibleItems.length,
    selected: selIdx,
    window: `[${window.start}..${window.end})`,
    hidden: hiddenTotal,
    filter: filterText || '(empty)',
  });

  const title = filterText
    ? truncateDisplay(`Commands matching “${filterText}”`, contentWidth)
    : 'Commands';

  return (
    <SoftPanel width={frame.width} marginX={frame.marginX}>
      <PanelTitle>{title}</PanelTitle>

      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>
          No matching commands
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const globalIndex = window.start + index;
          const isSelected = globalIndex === selIdx;
          return (
            <SelectionRow
              key={`${item.category}-${item.name}-${globalIndex}`}
              selected={isSelected}
              width={contentWidth}
            >
              {formatCommandRow(item, isSelected, contentWidth, compact, shimmer, screenReader)}
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
