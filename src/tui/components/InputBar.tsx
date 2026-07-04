import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTimedFlash, usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CommandMenu } from './CommandMenu.js';
import { makeDivider } from './word-wrap.js';
import type { PermissionMode, SlashCommand } from '../../types.js';
import { expandAtMentions, expandShellCommands } from '../input-expansion.js';
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
  terminalWidth?: number;
  maxMenuRows?: number;
  compact?: boolean;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /**
   * True when a higher-priority modal (permission prompt) owns the keyboard.
   * Ink's `useInput` fans every keypress to ALL registered handlers regardless
   * of focus, so InputBar must silence BOTH its own `useInput` and TextInput's
   * (via `focus`) while a modal is up — otherwise Enter/Tab/Esc double-fire and
   * the user confirming a permission accidentally interrupts the stream.
   */
  inputSuppressed?: boolean;
  /** Called when the user presses Enter while `disabled` (agent running) — interrupts the stream. */
  onInterrupt?: () => void;
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

function getSelectedCommandValue(commands: SlashCommand[], filter: string, selectedIndex: number): string | null {
  const matches = getFilteredCommands(commands, filter);
  if (matches.length === 0) return null;
  const index = Math.max(0, Math.min(selectedIndex, matches.length - 1));
  return '/' + matches[index].name;
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
export function InputBar({
  onSubmit,
  disabled,
  mode,
  onCycleMode,
  onInterrupt,
  onGlobalShortcut,
  inputSuppressed = false,
  commands = [],
  terminalWidth = 80,
  maxMenuRows = 8,
  compact = false,
  reducedMotion = false,
  screenReader = false,
}: InputBarProps) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [submitFlashKey, setSubmitFlashKey] = useState(0);
  const suggestion = compact ? 'Ask...' : 'Ask me anything...';

  // Command menu state
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuFilter, setMenuFilter] = useState('');
  const [menuSelected, setMenuSelected] = useState(0);
  const menuVisibleRef = useRef(false);
  const menuFilterRef = useRef('');
  const menuSelectedRef = useRef(0);

  const filteredCmds = useMemo(
    () => getFilteredCommands(commands, menuFilter),
    [commands, menuFilter],
  );
  menuVisibleRef.current = menuVisible;
  menuFilterRef.current = menuFilter;
  menuSelectedRef.current = menuSelected;

  useInput((_input, key) => {
    // While a modal (permission prompt) owns the keyboard, ignore all keys —
    // PermissionButtons handles them. Without this, Ink fires every `useInput`
    // handler on every keypress, so Enter/Tab/Esc would double-fire.
    if (inputSuppressed) return;
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
      // Enter is resolved in handleSubmit, where TextInput passes the current value.
      if (key.return) return;
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
      if (menuVisibleRef.current) {
        const commandValue = getSelectedCommandValue(commands, menuFilterRef.current, menuSelectedRef.current);
        setMenuVisible(false);
        setMenuSelected(0);
        setValue('');
        if (!commandValue) return;
        if (disabled) {
          setSubmitFlashKey((key) => key + 1);
          onInterrupt?.();
        } else {
          setHistory((h) => [commandValue, ...h].slice(0, 100));
          setHistoryIndex(-1);
          recordCommandUse(commandValue.slice(1));
          setSubmitFlashKey((key) => key + 1);
          onSubmit(commandValue);
        }
        return;
      }

      // Dismiss menu on submit.
      setMenuVisible(false);
      setMenuSelected(0);

      const normalized = normalizeInput(val);
      if (!normalized.trim()) return;
      // While the agent is running, Enter interrupts the stream instead of
      // submitting — input stays live and focusable so the user can act.
      if (disabled) {
        setSubmitFlashKey((key) => key + 1);
        onInterrupt?.();
        setValue('');
        return;
      }
      setHistory((h) => [normalized, ...h].slice(0, 100));
      setHistoryIndex(-1);

      // Track command usage for autocomplete ranking.
      const cmdName = extractCommandName(normalized);
      if (cmdName) recordCommandUse(cmdName);

      // Preprocess: expand @-mentions and !-shell commands before submitting.
      const workspace = process.env.BOOK_WORKSPACE || process.cwd();
      let processed = expandAtMentions(normalized, workspace);
      processed = expandShellCommands(processed, workspace);

      setSubmitFlashKey((key) => key + 1);
      onSubmit(processed);
      setValue('');
    },
    [commands, disabled, onInterrupt, onSubmit],
  );

  const tokenKey = MODE_BORDER_TOKENS[mode];
  const baseBorderColor = theme[tokenKey];
  const motionDisabled = reducedMotion || screenReader;
  const promptPulse = usePulse(!disabled && !inputSuppressed && !motionDisabled, 700);
  const submitFlash = useTimedFlash(submitFlashKey, 220, motionDisabled);

  const width = Math.max(20, Math.floor(terminalWidth));
  const divider = useMemo(() => makeDivider(width, 2), [width]);
  const innerWidth = Math.max(1, width - 2);
  const inputWidth = Math.max(1, innerWidth - 2);
  const borderColor = submitFlash || (promptPulse && !compact) ? theme.brandShimmer : baseBorderColor;
  const placeholder = disabled
    ? compact ? 'Enter interrupts' : 'Press Enter to interrupt… (or keep typing)'
    : suggestion;

  const selIdx = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{divider}</Text>

      <CommandMenu
        items={filteredCmds}
        filterText={menuFilter}
        selectedIndex={selIdx}
        visible={menuVisible}
        terminalWidth={width}
        maxRows={maxMenuRows}
        compact={compact}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
      />

      <Box width={innerWidth}>
        <Text color={borderColor}>{'> '}</Text>
        <Box width={inputWidth} flexShrink={1}>
          <TextInput
            value={value}
            onChange={safeOnChange}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            // Stay focused while disabled so Enter can route to the interrupt
            // path; only yield to a modal (permission prompt). `focus` here maps
            // to TextInput's internal `useInput` isActive — see inputSuppressed.
            focus={!inputSuppressed}
          />
        </Box>
      </Box>
    </Box>
  );
}
