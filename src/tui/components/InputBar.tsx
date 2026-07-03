import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { PermissionMode, SlashCommand } from '../../types.js';
import { expandAtMentions, expandShellCommands } from '../input-expansion.js';
import { BUILTIN_COMMANDS, BUILTIN_BY_NAME } from '../../commands/builtins.js';
import { recordCommandUse } from '../../commands/recent.js';
import {
  getCommandsForEmptyQuery,
  getCommandsForQuery,
  type CommandItem,
} from '../../commands/filter.js';

const MODE_BORDER_TOKENS: Record<PermissionMode, 'brand' | 'success' | 'planMode' | 'autoAccept' | 'error'> = {
  default: 'brand',
  auto: 'success',
  plan: 'planMode',
  'accept-edits': 'autoAccept',
  dontAsk: 'error',
  bypassPermissions: 'success',
};

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  mode: PermissionMode;
  onCycleMode: () => void;
  /** Forward unrecognized global keyboard shortcuts to the parent App. */
  onGlobalShortcut?: (input: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean; tab?: boolean }) => boolean;
  /** Commands for the autocomplete menu (from discoverCommands). */
  commands?: SlashCommand[];
}

/**
 * Normalize a string to NFC (Canonical Composition) for consistent Unicode handling.
 */
function normalizeInput(value: string): string {
  return value.normalize('NFC');
}

/**
 * Strip SGR mouse escape sequences that leak through from ink-text-input.
 */
function stripMouseSequences(val: string): string {
  return val.replace(/\[<[0-9;]*[Mm]/g, '');
}

function getFilteredCommands(commands: SlashCommand[], filter: string): CommandItem[] {
  if (!filter) {
    return getCommandsForEmptyQuery(commands);
  }
  return getCommandsForQuery(commands, filter);
}

/**
 * Extract the command name from a slash command submission for usage tracking.
 */
function extractCommandName(value: string): string | null {
  const match = value.match(/^\/(\S+)/);
  return match ? match[1] : null;
}

/**
 * Claude Code-style input bar with command autocomplete menu.
 *
 * When the user types `/` at the start of input, a command menu appears above
 * the input showing matching commands. Arrow keys navigate, Tab auto-fills,
 * and Enter on a selected item submits the command.
 *
 * Empty "/" shows commands categorized: recently used → builtins → user → project.
 * Typing after "/" uses fuzzy search with exact > prefix > fuzzy ranking.
 */
export function InputBar({ onSubmit, disabled, mode, onCycleMode, onGlobalShortcut, commands = [] }: InputBarProps) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const suggestion = 'Ask me anything...';

  // Command menu state
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuFilter, setMenuFilter] = useState('');
  const [menuSelected, setMenuSelected] = useState(0);

  // Ref to suppress TextInput's onSubmit when the menu already handled Enter.
  const menuHandledSubmit = useRef(false);

  // Ref for the current input value so useInput always has the latest text,
  // even when React batches onChange before re-rendering.
  const valueRef = useRef(value);

  const filteredCmds = useMemo(
    () => getFilteredCommands(commands, menuFilter),
    [commands, menuFilter],
  );

  useInput((_input, key) => {
    // Filter out Alt/Meta-modified keys — they're shortcuts, not text input.
    if (key.meta) return;

    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }

    // ---- Command menu keyboard handling ----
    if (menuVisible) {
      // Escape: dismiss menu
      if (key.escape) {
        setMenuVisible(false);
        setMenuSelected(0);
        return;
      }
      // Tab: auto-fill selected command
      if (key.tab) {
        if (filteredCmds.length > 0) {
          const sel = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));
          const cmd = filteredCmds[sel];
          setValue('/' + cmd.name + ' ');
          setMenuVisible(false);
          setMenuSelected(0);
        }
        return;
      }
      // Down arrow: next item
      if (key.downArrow) {
        setMenuSelected((prev) => {
          const next = prev + 1;
          return next >= filteredCmds.length ? 0 : next;
        });
        return;
      }
      // Up arrow: previous item
      if (key.upArrow) {
        setMenuSelected((prev) => {
          const next = prev - 1;
          return next < 0 ? Math.max(0, filteredCmds.length - 1) : next;
        });
        return;
      }
      // Enter: dismiss the menu. TextInput's onSubmit will handle the
      // typed text through the normal handleSubmit path.
      if (key.return) {
        setMenuVisible(false);
        setMenuSelected(0);
        // Don't return — let TextInput see the \r and fire onSubmit.
      }
      // Character keys update the filter via onChange — stay visible so the
      // user can continue typing the command name. The menu is dismissed by
      // onChange when a space is typed or the leading / is removed.
    }

    // ---- Normal mode (no menu) ----
    // Tab to accept suggestion when input is empty
    if (key.tab && !value) {
      setValue(normalizeInput(suggestion));
      return;
    }
    // Forward Ctrl-based shortcuts to the parent App.
    if (key.ctrl && onGlobalShortcut) {
      if (onGlobalShortcut(_input, key)) return;
    }
    // Up arrow — navigate history backward
    if (key.upArrow && history.length > 0 && historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setValue(history[newIdx]);
      return;
    }
    // Down arrow — navigate history forward
    if (key.downArrow && historyIndex >= 0) {
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      setValue(newIdx >= 0 ? history[newIdx] : '');
      return;
    }
  });

  const safeOnChange = useCallback((val: string) => {
    const clean = stripMouseSequences(val);
    setValue(clean);
    valueRef.current = clean; // keep ref current before React re-renders

    // Detect / at start for command menu.
    // Show menu when: starts with /, no space (still typing command name).
    if (clean.startsWith('/') && !clean.includes(' ')) {
      setMenuVisible(true);
      setMenuFilter(clean.slice(1));
      setMenuSelected(0);
    } else if (clean.startsWith('/') && clean.includes(' ')) {
      // User typed a space after command name — dismiss menu, they're typing args.
      setMenuVisible(false);
    } else {
      setMenuVisible(false);
    }
  }, []);

  const handleSubmit = useCallback(
    (val: string) => {
      // If the menu already handled this Enter, skip TextInput's onSubmit.
      if (menuHandledSubmit.current) {
        menuHandledSubmit.current = false;
        return;
      }

      // Dismiss menu on submit.
      setMenuVisible(false);
      setMenuSelected(0);

      const normalized = normalizeInput(val);
      if (!normalized.trim() || disabled) return;
      setHistory((h) => [normalized, ...h].slice(0, 100));
      setHistoryIndex(-1);

      // Track command usage for autocomplete ranking.
      const cmdName = extractCommandName(normalized);
      if (cmdName) recordCommandUse(cmdName);

      // Preprocess: expand @-mentions and !-shell commands before submitting.
      const workspace = process.env.BOOK_WORKSPACE || process.cwd();
      let processed = expandAtMentions(normalized, workspace);
      processed = expandShellCommands(processed, workspace);

      onSubmit(processed);
      setValue('');
    },
    [disabled, onSubmit],
  );

  const tokenKey = MODE_BORDER_TOKENS[mode];
  const borderColor = theme[tokenKey];

  const { stdout } = useStdout();
  const divider = useMemo(() => {
    const width = stdout?.columns ?? 80;
    return '─'.repeat(Math.max(5, width - 2));
  }, [stdout?.columns]);

  // Clamp selection
  const selIdx = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));

  // Category header colors
  const categoryColor: Record<string, string> = {
    recent: theme.brand,
    builtin: theme.subtle,
    user: theme.subtle,
    project: theme.subtle,
  };

  // Group filtered commands by category for sectioned display
  const sections = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const cmd of filteredCmds) {
      const cat = cmd.category;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(cmd);
    }
    return groups;
  }, [filteredCmds]);

  // Flatten sections into indexed list for selection
  const flatItems = useMemo(
    () => filteredCmds,
    [filteredCmds],
  );

  const categoryLabels: Record<string, string> = {
    recent: 'Recently Used',
    builtin: 'Built-in',
    user: 'User',
    project: 'Project',
  };

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{divider}</Text>

      {/* Command autocomplete menu — renders above the input */}
      {menuVisible && (
        <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1}>
          <Text bold color={theme.brand}>
            Commands
          </Text>
          {flatItems.length === 0 ? (
            <Text color={theme.subtle} dimColor>
              No matching commands
            </Text>
          ) : (
            // Render sections with category headers
            Array.from(sections.entries()).map(([category, items]) => {
              const label = categoryLabels[category];
              const firstIdx = flatItems.indexOf(items[0]);
              return (
                <Box key={category} flexDirection="column">
                  {menuFilter === '' && label && (
                    <Text color={theme.subtle} dimColor>
                      {label}
                    </Text>
                  )}
                  {items.map((item) => {
                    const globalIdx = flatItems.indexOf(item);
                    const isSelected = globalIdx === selIdx;
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
              );
            })
          )}
        </Box>
      )}

      <Box>
        <Text color={borderColor}>{'> '}</Text>
        <Box flexGrow={1}>
          <TextInput
            value={value}
            onChange={safeOnChange}
            onSubmit={handleSubmit}
            placeholder={disabled ? 'Waiting for response...' : suggestion}
            focus={!disabled}
          />
        </Box>
      </Box>
    </Box>
  );
}
