import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { useEffect, useMemo } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import { useDensityMetrics } from '../density.js';
import { PanelTitle, SelectionRow, SoftPanel } from './chrome.js';

/**
 * One row. The caller formats `label` — padding, columns, whatever the list
 * needs — and `ListPicker` owns the marker, the colours and the window.
 */
export interface ListPickerItem {
  /** React key; also the default filter text. */
  key: string;
  label: string;
  /** Shown indented under the row, only while it is selected. */
  detail?: string;
  /** Appended to the label, e.g. `(current)` or `(unavailable)`. */
  note?: string;
  /** The row that is already in effect: coloured `brand` when not selected. */
  accent?: boolean;
  /** Render unselected rows subtle rather than as body text. */
  muted?: boolean;
  /** Dimmed, and Enter refuses it. */
  disabled?: boolean;
  /** Matched against the typed filter when `filterable`. Defaults to `label`. */
  filterText?: string;
}

interface ListPickerProps {
  title: string;
  subtitle?: string;
  items: readonly ListPickerItem[];
  /** Shown in place of the list when `items` is empty. */
  emptyText?: string;
  /** Where the cursor starts, and where it returns when this value changes. */
  initialIndex?: number;
  /** Rows drawn at once. Longer lists window around the cursor and page. */
  maxVisible?: number;
  width?: number;
  marginX?: number;
  /** The verb after Enter — "save", "resume", "sign in". */
  enterHint: string;
  /**
   * The verb after Esc. Dialogs used to pick their own — cancel, back, close,
   * not now — so the same key was described four ways depending on which one
   * you had open. `cancel` is the default because abandoning the choice is what
   * Esc does in a picker; override only where it genuinely returns to a
   * previous step, which is the one case a different word earns.
   */
  escHint?: string;
  /** Extra chords to advertise, already formatted: `R reset to inherit`. */
  extraHints?: string;
  /** Tab as "next row". Off by default: Tab means completion in the composer. */
  tabMovesNext?: boolean;
  /** Let printable keys filter the list. */
  filterable?: boolean;
  error?: string;
  /** Rendered above the hint line — "Restoring...". */
  status?: string;
  /** Stop taking keys without unmounting — a picker waiting on its own work. */
  isActive?: boolean;
  onSelect: (index: number) => void;
  onCancel: () => void;
  /**
   * Component-specific keys. Return `true` to claim the keypress; `ListPicker`
   * gives it first refusal on everything except Esc, so a picker can bind `R`
   * without reimplementing the cursor. Receives the batch-safe row index.
   */
  onKey?: (input: string, key: Key, index: number) => boolean;
}

/**
 * The list dialog every picker was rebuilding.
 *
 * Seven components carried their own copy of "cursor, wrap on the arrows, Enter
 * acts, Esc leaves, and a dim hint line at the bottom". They drifted, in the
 * ways duplicated code drifts: `SessionPicker` wrapped its cursor over every
 * session while drawing only the first twelve, so past the twelfth nothing was
 * highlighted and Enter resumed a session that was never on screen; `LoginPicker`
 * marked its selection with `❯` after the rest of the TUI had settled on `›`;
 * none of them paged, so a long list could only be walked one row at a time.
 *
 * The cursor lives in `useKeyState`, so every adopter is batch-safe against the
 * paste and key-repeat case (#165) without having to remember to be.
 */
export function ListPicker({
  title,
  subtitle,
  items,
  emptyText = '(nothing to choose from)',
  initialIndex = 0,
  maxVisible = 10,
  width,
  marginX,
  enterHint,
  escHint = 'cancel',
  extraHints,
  tabMovesNext = false,
  filterable = false,
  error,
  status,
  isActive = true,
  onSelect,
  onCancel,
  onKey,
}: ListPickerProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [filter, setFilter, currentFilter] = useKeyState('');
  const [selected, setSelected, currentSelected] = useKeyState(initialIndex);

  const visibleItems = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => (item.filterText ?? item.label).toLowerCase().includes(needle));
  }, [filter, items]);

  // Re-home the cursor when the caller's idea of "current" moves, and keep it
  // inside a list that just got shorter — a filter keystroke can strand it past
  // the end, which is how Enter ends up acting on nothing.
  //
  // The first effect clamps against `visibleItems` without depending on it, so
  // items must be present at mount. Every adopter builds them synchronously; an
  // adopter that loaded them asynchronously with a non-zero `initialIndex`
  // would clamp against an empty list and never re-run.
  useEffect(() => {
    setSelected(Math.max(0, Math.min(initialIndex, visibleItems.length - 1)));
  }, [initialIndex, setSelected]);
  useEffect(() => {
    if (currentSelected() > visibleItems.length - 1) {
      setSelected(Math.max(0, visibleItems.length - 1));
    }
  }, [visibleItems.length, currentSelected, setSelected]);

  const move = (next: number) => {
    if (visibleItems.length === 0) return;
    setSelected(((next % visibleItems.length) + visibleItems.length) % visibleItems.length);
  };
  // Paging clamps rather than wraps. Page-Down on the last screen of a long list
  // should land on the end, not spring back to the top.
  const page = (delta: number) => {
    if (visibleItems.length === 0) return;
    setSelected(Math.max(0, Math.min(visibleItems.length - 1, currentSelected() + delta)));
  };

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (onKey?.(input, key, currentSelected())) return;
      if (key.upArrow) return move(currentSelected() - 1);
      if (key.downArrow || (tabMovesNext && key.tab && !key.shift)) {
        return move(currentSelected() + 1);
      }
      if (tabMovesNext && key.tab && key.shift) return move(currentSelected() - 1);
      if (key.pageUp) return page(-maxVisible);
      if (key.pageDown) return page(maxVisible);
      if (key.return) {
        const item = visibleItems[currentSelected()];
        if (!item || item.disabled) return;
        onSelect(items.indexOf(item));
        return;
      }
      if (!filterable || key.ctrl || key.meta) return;
      if (key.backspace || key.delete) {
        setFilter(currentFilter().slice(0, -1));
        return;
      }
      if (input && input >= ' ') setFilter(currentFilter() + input);
    },
    { isActive },
  );

  // Centre the cursor once the list is longer than the window, and stop the
  // window running off the end.
  const start =
    visibleItems.length <= maxVisible
      ? 0
      : Math.max(
          0,
          Math.min(selected - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
        );
  const window = visibleItems.slice(start, start + maxVisible);
  const hidden = visibleItems.length - window.length;

  return (
    <SoftPanel tone="brand" width={width} marginX={marginX}>
      <PanelTitle>{title}</PanelTitle>
      {subtitle ? <Text color={theme.subtle}>{subtitle}</Text> : null}
      {filterable && filter ? <Text color={theme.subtle}>filter: {filter}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {visibleItems.length === 0 ? (
          <Text color={theme.subtle}>{filter ? '(no matches)' : emptyText}</Text>
        ) : (
          window.map((item, offset) => {
            const index = start + offset;
            const isSelected = index === selected;
            return (
              <Box key={item.key} flexDirection="column">
                <SelectionRow selected={isSelected} width={width ? width - 4 : undefined}>
                  <Text
                    color={
                      item.disabled
                        ? theme.subtle
                        : isSelected
                          ? theme.selectionText
                          : item.accent
                            ? theme.brand
                            : item.muted
                              ? theme.subtle
                              : theme.text
                    }
                    bold={(isSelected || item.accent) && !item.disabled}
                    dimColor={item.disabled}
                  >
                    {isSelected ? '›' : ' '} {item.label}
                    {item.note ? `  ${item.note}` : ''}
                  </Text>
                </SelectionRow>
                {isSelected && item.detail ? (
                  <Text color={theme.subtle} dimColor>
                    {'  '}
                    {item.detail}
                  </Text>
                ) : null}
              </Box>
            );
          })
        )}
        {hidden > 0 ? <Text color={theme.subtle}>+{hidden} more</Text> : null}
      </Box>
      {status ? <Text color={theme.brand}>{status}</Text> : null}
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
      {density.showOptionalHelp ? (
        <Text color={theme.subtle} dimColor>
          {[
            '↑↓ select',
            visibleItems.length > maxVisible ? 'PgUp/PgDn page' : undefined,
            filterable ? 'type to filter' : undefined,
            `Enter ${enterHint}`,
            extraHints,
            `Esc ${escHint}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}
    </SoftPanel>
  );
}
