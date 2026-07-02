import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { PermissionMode, SlashCommand } from '../../types.js';
import { expandAtMentions, expandShellCommands } from '../input-expansion.js';

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

// Built-in command metadata (mirrors CommandMenu for auto-fill).
const BUILTIN_NAMES = new Set([
  'clear', 'compact', 'exit', 'help', 'task', 'theme',
  'model', 'config', 'diff', 'status', 'memory',
  'permissions', 'cost', 'skills', 'init', 'reload-skills', 'export',
]);

const BUILTIN_DESCS: Record<string, string> = {
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

interface CommandItem {
  name: string;
  hint: string;
  desc: string;
}

function getFilteredCommands(commands: SlashCommand[], filter: string): CommandItem[] {
  const allItems: CommandItem[] = [];

  for (const name of BUILTIN_NAMES) {
    allItems.push({ name, hint: '', desc: BUILTIN_DESCS[name] || '' });
  }

  for (const cmd of commands) {
    if (BUILTIN_NAMES.has(cmd.name)) continue;
    allItems.push({ name: cmd.name, hint: cmd.argumentHint || '', desc: cmd.description });
  }

  const f = filter.toLowerCase();
  const filtered = allItems.filter((item) => {
    if (!f) return true;
    return item.name.toLowerCase().startsWith(f) || item.name.toLowerCase().includes(f);
  });

  // Sort: prefix matches first, then substring
  filtered.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(f) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(f) ? 0 : 1;
    return aPrefix - bPrefix;
  });

  return filtered;
}

/**
 * Claude Code-style input bar with command autocomplete menu.
 *
 * When the user types `/` at the start of input, a command menu appears above
 * the input showing matching commands. Arrow keys navigate, Tab auto-fills,
 * and Enter on a selected item submits the command.
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
      // Enter: submit the selected command directly
      if (key.return) {
        if (filteredCmds.length > 0) {
          const sel = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));
          const cmd = filteredCmds[sel];
          const fullCmd = '/' + cmd.name + ' ';
          // Submit directly — bypass history navigation since we're
          // auto-filling a command.
          setMenuVisible(false);
          setMenuSelected(0);
          setValue('');
          const normalized = normalizeInput(fullCmd);
          setHistory((h) => [normalized, ...h].slice(0, 100));
          setHistoryIndex(-1);
          const workspace = process.env.BOOK_WORKSPACE || process.cwd();
          let processed = expandAtMentions(normalized, workspace);
          processed = expandShellCommands(processed, workspace);
          onSubmit(processed);
        }
        return;
      }
      // Any other key while menu is visible: dismiss menu (user is typing args).
      // But we need to let the character through — handled by checking value
      // changes below.
      return;
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
      // Dismiss menu on submit.
      setMenuVisible(false);
      setMenuSelected(0);

      const normalized = normalizeInput(val);
      if (!normalized.trim() || disabled) return;
      setHistory((h) => [normalized, ...h].slice(0, 100));
      setHistoryIndex(-1);

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

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{divider}</Text>

      {/* Command autocomplete menu — renders above the input */}
      {menuVisible && (
        <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1}>
          <Text bold color={theme.brand}>
            Commands
          </Text>
          {filteredCmds.length === 0 ? (
            <Text color={theme.subtle} dimColor>
              No matching commands
            </Text>
          ) : (
            filteredCmds.map((item, i) => {
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
