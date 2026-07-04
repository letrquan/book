import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { CommandItem } from '../../commands/filter.js';

interface CommandMenuProps {
  /** Pre-filtered and categorized command items to display. */
  items: CommandItem[];
  /** Current filter text (empty = show categorized sections). */
  filterText: string;
  /** Index of the currently selected item in the flattened list. */
  selectedIndex: number;
  /** Whether the menu is visible. */
  visible: boolean;
}

const CATEGORY_LABELS: Record<CommandItem['category'], string> = {
  recent: 'Recent',
  builtin: 'Built-in',
  user: 'User',
  project: 'Project',
};

const CATEGORY_ORDER: CommandItem['category'][] = ['recent', 'builtin', 'user', 'project'];

/** Slash-command palette. Filtering/ranking lives in commands/filter.ts. */
export function CommandMenu({ items, filterText, selectedIndex, visible }: CommandMenuProps) {
  const theme = useTheme();

  if (!visible) return null;

  const selIdx = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const showSections = filterText.trim() === '';
  const sections = showSections
    ? CATEGORY_ORDER.map((category) => ({
        category,
        items: items.filter((item) => item.category === category),
      })).filter((section) => section.items.length > 0)
    : [{ category: undefined, items }];

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1}>
      <Box>
        <Text bold color={theme.brand}>Commands</Text>
        {filterText ? <Text color={theme.subtle}> matching “{filterText}”</Text> : null}
      </Box>

      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>No matching commands</Text>
      ) : (
        sections.map((section) => (
          <Box key={section.category ?? 'matches'} flexDirection="column">
            {section.category ? (
              <Text color={theme.subtle} dimColor>{CATEGORY_LABELS[section.category]}</Text>
            ) : null}
            {section.items.map((item) => {
              const globalIndex = items.indexOf(item);
              const isSelected = globalIndex === selIdx;
              const color = isSelected ? theme.brand : theme.text;
              const hint = item.hint ? ` ${item.hint}` : '';
              return (
                <Box key={`${item.category}-${item.name}`}>
                  <Text color={color} bold={isSelected}>{isSelected ? '› ' : '  '}/{item.name}{hint}</Text>
                  <Text color={theme.subtle}> [{CATEGORY_LABELS[item.category]}]</Text>
                  {item.desc ? <Text color={theme.subtle}> — {item.desc}</Text> : null}
                </Box>
              );
            })}
          </Box>
        ))
      )}
    </Box>
  );
}
