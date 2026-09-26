import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import type { CommandItem } from '../../commands/filter.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { createRenderDebugLogger } from '../../debug-log.js';
import { floatingFrameMetrics, SoftPanel } from './chrome.js';
import { frameGrid } from '../layout.js';
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

/** Columns between the name column and the description. */
const DESC_SEPARATOR = '  ';

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
  /** Spaces after the name (and hint, and badge) that bring the description to its column. */
  pad: string;
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
  /**
   * Width of the name column: the widest visible name. Every description then
   * starts on the same column, so the list reads as two columns instead of a
   * ragged run of `name — description` rows.
   */
  nameWidth?: number;
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
  const { selected, width, compact, screenReader, showBadge, nameWidth = 0 } = options;
  // One steady mark. It used to pulse between `›` and `▸`, a blink that drew
  // the eye to the list's chrome instead of to the command.
  const marker = screenReader ? (selected ? 'selected ' : '') : selected ? '› ' : '  ';
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
  const lead = displayWidth(name) + displayWidth(keptHint) + displayWidth(badge);
  const padWidth = compact || screenReader ? 0 : Math.max(0, nameWidth - lead);
  const descBudget = width - fixed - displayWidth(keptHint) - padWidth - DESC_SEPARATOR.length;
  const desc =
    item.desc && !compact && descBudget >= MIN_DESC_WIDTH
      ? `${DESC_SEPARATOR}${truncateDisplay(item.desc, descBudget)}`
      : '';

  return { marker, name, pad: desc ? ' '.repeat(padWidth) : '', hint: keptHint, badge, desc };
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
  void reducedMotion;

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

  const title = filterText ? `Commands matching “${filterText}”` : 'Commands';
  const count = `${items.length} ${items.length === 1 ? 'command' : 'commands'}`;
  // The name column: the widest visible name, capped so a long custom command
  // cannot squeeze every description away.
  const nameWidth = Math.min(
    Math.max(...visibleItems.map((item) => displayWidth(`/${item.name}`)), 0),
    Math.floor(contentWidth * 0.4),
  );

  // The hairline spans the terminal like the composer's; rows keep the panel measure.
  return (
    <SoftPanel
      width={frameGrid(width).width}
      marginX={frame.marginX}
      attached
      title={title}
      meta={hiddenTotal > 0 ? `${count} · type to filter` : count}
    >
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
            shimmer: false,
            screenReader,
            showBadge,
            nameWidth,
          });
          // The name in ink, the syntax and badge quiet, the description a step
          // quieter still; the selected row is marked and bold, never barred.
          return (
            <Box key={`${item.category}-${item.name}-${globalIndex}`} width={contentWidth}>
              <Text color={theme.brand}>{row.marker}</Text>
              <Text bold={isSelected} color={isSelected ? theme.selectionText : theme.text}>
                {row.name}
              </Text>
              <Text color={theme.inactive}>{row.hint}</Text>
              <Text color={theme.inactive}>{row.badge}</Text>
              <Text>{row.pad}</Text>
              <Text color={isSelected ? theme.text : theme.inactive}>{row.desc}</Text>
            </Box>
          );
        })
      )}
    </SoftPanel>
  );
}
