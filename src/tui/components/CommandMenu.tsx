import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { SlashCommand } from '../../types.js';

interface CommandMenuProps {
  commands: SlashCommand[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
}

/**
 * Filterable command autocomplete menu that appears when the user types `/`.
 *
 * Renders as an inline panel above the input bar showing matching commands.
 * The selected item is highlighted with the theme's brand color.
 *
 * Sections:
 *   - Built-in: hardcoded commands that don't come from .md files
 *   - Custom: commands discovered from .book/commands/
 */
export function CommandMenu({ commands, filterText, selectedIndex, visible }: CommandMenuProps) {
  const theme = useTheme();

  if (!visible) return null;

  // Build the full command list: built-in first, then custom.
  const builtinNames = new Set([
    'clear', 'compact', 'exit', 'help', 'task', 'theme',
    'model', 'config', 'diff', 'status', 'memory',
    'permissions', 'cost', 'skills', 'init', 'reload-skills', 'export',
  ]);

  const builtinDescs: Record<string, string> = {
    clear: 'Clear conversation',
    compact: 'Summarize older turns',
    exit: 'Exit book',
    help: 'Toggle help',
    task: 'Add a task',
    theme: 'Switch theme',
    model: 'Switch AI model',
    config: 'Show current configuration',
    diff: 'Show git diff',
    status: 'Show session status',
    memory: 'Edit CLAUDE.md / manage auto-memory',
    permissions: 'Manage permission rules',
    cost: 'Show token usage and cost',
    skills: 'List available skills',
    init: 'Initialize project with CLAUDE.md',
    'reload-skills': 'Re-scan command and skill directories',
    export: 'Export conversation to file',
  };

  // Build unified list: built-in descriptions + custom commands
  const allItems: Array<{ name: string; hint: string; desc: string; isBuiltin: boolean }> = [];

  for (const name of builtinNames) {
    allItems.push({
      name,
      hint: '',
      desc: builtinDescs[name] || '',
      isBuiltin: true,
    });
  }

  for (const cmd of commands) {
    // Skip commands whose names collide with built-in names
    if (builtinNames.has(cmd.name)) continue;
    allItems.push({
      name: cmd.name,
      hint: cmd.argumentHint || '',
      desc: cmd.description,
      isBuiltin: false,
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

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={0}>
      <Text bold color={theme.brand}>
        Commands
      </Text>
      {filtered.map((item, i) => {
        const isSelected = i === selIdx;
        const color = isSelected ? theme.brand : theme.text;
        const bg = isSelected ? theme.userBg : undefined;
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
  );
}
