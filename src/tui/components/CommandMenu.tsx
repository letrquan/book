import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { SlashCommand } from '../../types.js';
import { BUILTIN_BY_NAME } from '../../commands/builtins.js';
import type { CommandItem } from '../../commands/filter.js';

interface CommandMenuProps {
  commands: SlashCommand[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
}

const categoryLabels: Record<string, string> = {
  recent: 'Recently Used',
  builtin: 'Built-in',
  user: 'User',
  project: 'Project',
};

/**
 * Filterable command autocomplete menu that appears when the user types `/`.
 *
 * Renders as an inline panel above the input bar showing matching commands.
 * The selected item is highlighted with the theme's brand color.
 *
 * When filterText is empty, commands are shown in categorized sections:
 * recently used → built-ins → user → project.
 * When filterText is non-empty, results are ranked: exact > prefix > fuzzy.
 */
export function CommandMenu({ commands, filterText, selectedIndex, visible }: CommandMenuProps) {
  const theme = useTheme();

  if (!visible) return null;

  // Build the full command list: built-in first, then custom.
  const builtinNames = new Set(Object.keys(BUILTIN_BY_NAME));

  // Build unified list: built-in descriptions + custom commands
  const allItems: Array<{ name: string; hint: string; desc: string; isBuiltin: boolean; source: string }> = [];

  for (const [name, builtin] of Object.entries(BUILTIN_BY_NAME)) {
    if (builtin.isHidden) continue;
    allItems.push({
      name,
      hint: builtin.argumentHint ?? '',
      desc: builtin.description,
      isBuiltin: true,
      source: 'builtin',
    });
  }

  for (const cmd of commands) {
    // Skip commands whose names collide with built-in names
    if (builtinNames.has(cmd.name)) continue;
    if (cmd.isHidden) continue;
    allItems.push({
      name: cmd.name,
      hint: cmd.argumentHint || '',
      desc: cmd.description,
      isBuiltin: false,
      source: cmd.source,
    });
  }

  // Filter by filterText (match command name, prefix first)
  const filter = filterText.toLowerCase();
  const filtered = allItems.filter((item) => {
    if (!filter) return true;
    return item.name.toLowerCase().startsWith(filter)
      || item.name.toLowerCase().includes(filter);
  });

  // Sort: prefix matches first, then substring matches
  filtered.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(filter) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(filter) ? 0 : 1;
    return aPrefix - bPrefix;
  });

  if (filtered.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={0}>
        <Text color={theme.subtle} dimColor>
          No matching commands
        </Text>
      </Box>
    );
  }

  // Clamp selection to valid range.
  const selIdx = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  // Group by category when filter is empty
  const showCategories = !filter;

  // Build sections
  const sections: Array<{ label: string; items: typeof filtered }> = [];
  if (showCategories) {
    const categoryOrder = ['recent', 'builtin', 'user', 'project'] as const;
    const categoryItems: Record<string, typeof filtered> = {};
    for (const item of filtered) {
      // Determine category: builtin or from command source
      const cat = item.isBuiltin ? 'builtin' : item.source;
      if (!categoryItems[cat]) categoryItems[cat] = [];
      categoryItems[cat].push(item);
    }
    for (const cat of categoryOrder) {
      if (categoryItems[cat]?.length) {
        categoryItems[cat].sort((a, b) => a.name.localeCompare(b.name));
        sections.push({ label: categoryLabels[cat] || cat, items: categoryItems[cat] });
      }
    }
  } else {
    sections.push({ label: '', items: filtered });
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
              {section.label}
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
