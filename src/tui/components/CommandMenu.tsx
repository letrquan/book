import { Text } from 'ink';
import { useMemo } from 'react';
import { usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { CommandItem } from '../../commands/filter.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';
import { useDebugRender } from '../debug.js';

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

/** Narrower than this and a description is a stub, not a description. */
const MIN_DESC_WIDTH = 12;

const DESC_SEPARATOR = ' — ';

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

/** The runs of one command row, each free to carry its own colour. */
export interface CommandRow {
  marker: string;
  name: string;
  /** Argument syntax. Empty except on the selected row. */
  hint: string;
  /** Category badge. Empty when every visible row shares one category. */
  badge: string;
  desc: string;
}

export interface CommandRowOptions {
  selected: boolean;
  width: number;
  compact: boolean;
  shimmer: boolean;
  screenReader: boolean;
  /** False when the visible rows are all one category, making a badge noise. */
  showBadge: boolean;
}

/**
 * Lay out one command row.
 *
 * Three things used to compete for the same line. The argument syntax sat
 * between the name and the description, so `/agent` read
 * `<id>|send <id> <message>|stop <id> [Built-in] — Inspec…` — the grammar of the
 * command before any hint of what it does, and then the meaning truncated away.
 * The badge repeated `[Built-in]` down every row of a list that was entirely
 * built-ins. And the whole row was one colour, so the name did not stand out
 * from its own description.
 *
 * So: the description always follows the name, the syntax appears only on the
 * selected row — the list is for finding a command, the syntax matters once you
 * have found it — and the badge appears only when the rows actually differ.
 * The description absorbs whatever width is left, which is the part a reader
 * can lose a tail of and still recognize.
 */
export function composeCommandRow(item: CommandItem, options: CommandRowOptions): CommandRow {
  const { selected, width, compact, shimmer, screenReader, showBadge } = options;
  const marker = screenReader
    ? selected
      ? 'selected '
      : ''
    : selected
      ? shimmer
        ? '▸ '
        : '› '
      : '  ';
  const name = `/${item.name}`;
  const badge =
    showBadge && !screenReader
      ? ` [${compact ? COMPACT_CATEGORY_LABELS[item.category] : CATEGORY_LABELS[item.category]}]`
      : '';
  const hint = selected && item.hint ? ` ${item.hint}` : '';

  const fixed = displayWidth(marker) + displayWidth(name) + displayWidth(badge);
  // The syntax is only worth its columns if enough of the row survives to still
  // read as a row; below that the name and what it does win.
  const hintFits = hint && fixed + displayWidth(hint) + MIN_DESC_WIDTH <= width;
  const keptHint = hintFits ? hint : '';
  const descBudget = width - fixed - displayWidth(keptHint) - DESC_SEPARATOR.length;
  const desc =
    item.desc && !compact && descBudget >= MIN_DESC_WIDTH
      ? `${DESC_SEPARATOR}${truncateDisplay(item.desc, descBudget)}`
      : '';

  return { marker, name, hint: keptHint, badge, desc };
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
  // A badge every row shares carries no information: `[Built-in]` down a list of
  // nothing but built-ins is a column of noise between the name and its meaning.
  // Derived from the whole filtered list rather than the visible window, so the
  // column does not appear and vanish as the selection scrolls a differing row
  // in and out of view.
  const showBadge = useMemo(() => new Set(items.map((item) => item.category)).size > 1, [items]);
  const hiddenBefore = window.start;
  const hiddenAfter = Math.max(0, items.length - window.end);
  const hiddenTotal = hiddenBefore + hiddenAfter;

  useDebugRender(renderLog, {
    items: items.length,
    visible: visibleItems.length,
    selected: selIdx,
    window: `[${window.start}..${window.end})`,
    hidden: hiddenTotal,
    filter: filterText || '(empty)',
  });

  if (!visible) return null;

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
          const row = composeCommandRow(item, {
            selected: isSelected,
            width: contentWidth,
            compact,
            shimmer,
            screenReader,
            showBadge,
          });
          // A selected row is a single highlighted block, so its runs inherit
          // one colour; an unselected one uses colour to separate the name from
          // what it does.
          return (
            <SelectionRow
              key={`${item.category}-${item.name}-${globalIndex}`}
              selected={isSelected}
              width={contentWidth}
            >
              {isSelected ? (
                `${row.marker}${row.name}${row.hint}${row.badge}${row.desc}`
              ) : (
                <>
                  <Text>{row.marker}</Text>
                  <Text color={theme.brand}>{row.name}</Text>
                  <Text color={theme.subtle}>{row.hint}</Text>
                  <Text color={theme.subtle} dimColor>
                    {row.badge}
                  </Text>
                  <Text color={theme.subtle}>{row.desc}</Text>
                </>
              )}
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
