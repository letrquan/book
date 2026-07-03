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

const categoryLabels: Record<string, string> = {
  recent: 'Recently Used',
  builtin: 'Built-in',
  user: 'User',
  project: 'Project',
};

const sourceBadge: Record<string, string> = {
  recent: '⌛',
  builtin: '⚙',
  user: '~',
  project: '📁',
};

/**
 * Canonical command autocomplete menu for slash commands.
 *
 * Used by InputBar — the single source of truth for command menu rendering.
 * Groups commands by category when filterText is empty; flat list when filtering.
 * Shows source badges and usage metadata.
 */
export function CommandMenu({ items, filterText, selectedIndex, visible }: CommandMenuProps) {
  const theme = useTheme();

  if (!visible) return null;

  if (items.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={0}>
        <Text color={theme.subtle} dimColor>
          No matching commands
        </Text>
      </Box>
    );
  }

  const selIdx = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const showCategories = !filterText;

  // Group by category when filter is empty
  let sections: Array<{ label: string; badge: string; items: CommandItem[] }> = [];
  if (showCategories) {
    const categoryOrder = ['recent', 'builtin', 'user', 'project'] as const;
    const grouped: Record<string, CommandItem[]> = {};
    for (const item of items) {
      const cat = item.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    }
    for (const cat of categoryOrder) {
      if (grouped[cat]?.length) {
        grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
        sections.push({ label: categoryLabels[cat] || cat, badge: sourceBadge[cat] || '', items: grouped[cat] });
      }
    }
  } else {
    sections.push({ label: '', badge: '', items });
  }

  // Flatten for index lookup
  const flat = sections.flatMap((s) => s.items);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={0}>
      <Text bold color={theme.brand}>
        Commands
      </Text>
      {sections.map((section) => (
        <Box key={section.label} flexDirection="column">
          {section.label && (
            <Text color={theme.subtle} dimColor>
              {section.badge} {section.label}
            </Text>
          )}
          {section.items.map((item) => {
            const i = flat.indexOf(item);
            const isSelected = i === selIdx;
            const color = isSelected ? theme.brand : theme.text;
            const prefix = isSelected ? '› ' : '  ';
            const hint = item.hint ? ` ${item.hint}` : '';
            return (
              <Box key={item.name} flexDirection="row">
                <Text color={color} bold={isSelected}>
                  {prefix}/{item.name}{hint}
                </Text>
                {item.desc && (
                  <Text color={theme.subtle}> — {item.desc}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
