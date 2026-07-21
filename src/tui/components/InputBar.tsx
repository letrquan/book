import { Box, Text } from 'ink';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTimedFlash, usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CommandMenu } from './CommandMenu.js';
import { FileMentionMenu } from './FileMentionMenu.js';
import type { PermissionMode, SlashCommand } from '../../types.js';
import { modeColorToken } from '../mode-style.js';
import { floatingFrameMetrics } from './chrome.js';
import {
  findActiveFileMention,
  getFileMentionCandidates,
  replaceActiveFileMention,
  type ActiveFileMention,
  type FileMentionCandidate,
} from '../../input/file-mentions.js';
import { recordCommandUse } from '../../commands/recent.js';
import {
  getCommandsForEmptyQuery,
  getCommandsForQuery,
  type CommandItem,
} from '../../commands/filter.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { InputBox } from './InputBox.js';

const uiLog = createUiDebugLogger('tui:inputbar');
const FILE_MENTION_DEBOUNCE_MS = 40;

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
   * of focus, so InputBar must silence BOTH its own `useInput` and InputBox's
   * (via `focus`) while a modal is up — otherwise Enter/Tab/Esc double-fire and
   * the user confirming a permission accidentally interrupts the stream.
   */
  inputSuppressed?: boolean;
  /** Called when the user presses Enter while `disabled` (agent running) — interrupts the stream. */
  onInterrupt?: () => void;
  /** Forward unrecognized global keyboard shortcuts to the parent App. */
  onGlobalShortcut?: (
    input: string,
    key: {
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
      tab?: boolean;
      home?: boolean;
      end?: boolean;
    },
  ) => boolean;
  /** Commands for the autocomplete menu (from discoverCommands). */
  commands?: SlashCommand[];
  /** Keyed request used by conversation rewind to restore a prior prompt draft. */
  draftRestore?: { key: number; value: string };
}

/**
 * Normalize a string to NFC (Canonical Composition) for consistent Unicode handling.
 */
function normalizeInput(value: string): string {
  return value.normalize('NFC');
}

/**
 * Strip SGR mouse escape sequences before they can become prompt text.
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

function getSelectedCommandValue(
  commands: SlashCommand[],
  filter: string,
  selectedIndex: number,
): string | null {
  const matches = getFilteredCommands(commands, filter);
  if (matches.length === 0) return null;
  const index = Math.max(0, Math.min(selectedIndex, matches.length - 1));
  return '/' + matches[index].name;
}

function getSelectedFileMention(
  candidates: FileMentionCandidate[],
  selectedIndex: number,
): FileMentionCandidate | null {
  if (candidates.length === 0) return null;
  const index = Math.max(0, Math.min(selectedIndex, candidates.length - 1));
  return candidates[index];
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
  draftRestore,
}: InputBarProps) {
  const theme = useTheme();
  useDebugMount(uiLog, { compact, screenReader, commandsLen: commands.length });
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

  // File mention menu state
  const [fileMenuVisible, setFileMenuVisible] = useState(false);
  const [fileMention, setFileMention] = useState<ActiveFileMention | null>(null);
  const [fileCandidates, setFileCandidates] = useState<FileMentionCandidate[]>([]);
  const [fileSelected, setFileSelected] = useState(0);
  const fileMenuVisibleRef = useRef(false);
  const fileMentionRef = useRef<ActiveFileMention | null>(null);
  const fileSelectedRef = useRef(0);
  const fileCandidatesRef = useRef<FileMentionCandidate[]>([]);

  const filteredCmds = useMemo(
    () => getFilteredCommands(commands, menuFilter),
    [commands, menuFilter],
  );
  const workspace = process.env.BOOK_WORKSPACE || process.cwd();

  useEffect(() => {
    if (!fileMention) {
      setFileCandidates([]);
      return;
    }

    const controller = new AbortController();
    const query = fileMention.query;
    const timer = setTimeout(() => {
      void getFileMentionCandidates(workspace, query, 50, controller.signal)
        .then((candidates) => {
          if (controller.signal.aborted) return;
          setFileCandidates(candidates);
          setFileSelected((selected) =>
            candidates.length === 0 ? 0 : Math.min(selected, candidates.length - 1),
          );
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            uiLog.event('file-menu:error', {
              error: error instanceof Error ? error.message : String(error),
            });
            setFileCandidates([]);
          }
        });
    }, FILE_MENTION_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fileMention?.query, workspace]);

  menuVisibleRef.current = menuVisible;
  menuFilterRef.current = menuFilter;
  menuSelectedRef.current = menuSelected;
  fileMenuVisibleRef.current = fileMenuVisible;
  fileMentionRef.current = fileMention;
  fileSelectedRef.current = fileSelected;
  fileCandidatesRef.current = fileCandidates;

  useEffect(() => {
    if (!draftRestore) return;
    setValue(normalizeInput(draftRestore.value));
    setHistoryIndex(-1);
    setMenuVisible(false);
    setMenuSelected(0);
    setFileMenuVisible(false);
    setFileMention(null);
    setFileCandidates([]);
    setFileSelected(0);
  }, [draftRestore?.key]);

  const acceptSelectedFileMention = useCallback(
    (currentValue: string, trigger: 'Tab' | 'Enter'): boolean => {
      const mention = fileMentionRef.current;
      const selected = getSelectedFileMention(fileCandidatesRef.current, fileSelectedRef.current);
      if (!mention || !selected) return false;

      const nextValue = replaceActiveFileMention(currentValue, mention, selected.path);
      setValue(nextValue);
      const nextMention = findActiveFileMention(nextValue);
      setFileMention(nextMention);
      setFileMenuVisible(!!nextMention);
      setFileCandidates([]);
      setFileSelected(0);
      uiLog.event(`input:${trigger}`, { action: 'autofill-file-mention', path: selected.path });
      return true;
    },
    [],
  );

  useInput((_input, key) => {
    // Mouse reports are handled by TranscriptView. Ignore them here before
    // menu/history routing so wheel movement cannot mutate the prompt.
    if (_input.startsWith('[<') || _input.startsWith('\x1b[<')) return;

    // While a modal (permission prompt) owns the keyboard, ignore all keys —
    // PermissionButtons handles them. Without this, Ink fires every `useInput`
    // handler on every keypress, so Enter/Tab/Esc would double-fire.
    if (inputSuppressed) return;
    // Filter out Alt/Meta-modified keys — they're shortcuts, not text input.
    // Preserve the editor value while the parent handles Alt/Meta shortcuts.
    if (key.meta) {
      const preservedValue = value;
      queueMicrotask(() => setValue(preservedValue));
      return;
    }

    if (key.shift && key.tab) {
      onCycleMode();
      uiLog.event('input:Shift+Tab', { action: 'cycle-mode' });
      return;
    }

    // ---- Command menu keyboard handling ----
    if (menuVisible) {
      // Escape: dismiss menu
      if (key.escape) {
        setMenuVisible(false);
        setMenuSelected(0);
        uiLog.event('input:Escape', { action: 'dismiss-menu' });
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
          uiLog.event('input:Tab', { action: 'autofill-command', command: cmd.name });
        }
        return;
      }
      // Down arrow: next item
      if (key.downArrow) {
        setMenuSelected((prev) => {
          const next = prev + 1;
          return next >= filteredCmds.length ? 0 : next;
        });
        uiLog.event('input:Down', { action: 'menu-next-item' });
        return;
      }
      // Up arrow: previous item
      if (key.upArrow) {
        setMenuSelected((prev) => {
          const next = prev - 1;
          return next < 0 ? Math.max(0, filteredCmds.length - 1) : next;
        });
        uiLog.event('input:Up', { action: 'menu-prev-item' });
        return;
      }
      // Enter is resolved in handleSubmit, where InputBox passes the current value.
      if (key.return) return;
      // Character keys update the filter via onChange — stay visible so the
      // user can continue typing the command name. The menu is dismissed by
      // onChange when a space is typed or the leading / is removed.
    }

    // ---- File mention menu keyboard handling ----
    if (fileMenuVisible) {
      if (key.escape) {
        setFileMenuVisible(false);
        setFileMention(null);
        setFileCandidates([]);
        setFileSelected(0);
        uiLog.event('input:Escape', { action: 'dismiss-file-menu' });
        return;
      }
      if (key.tab) {
        acceptSelectedFileMention(value, 'Tab');
        return;
      }
      if (key.downArrow) {
        setFileSelected((prev) => {
          const next = prev + 1;
          return next >= fileCandidates.length ? 0 : next;
        });
        uiLog.event('input:Down', { action: 'file-menu-next-item' });
        return;
      }
      if (key.upArrow) {
        setFileSelected((prev) => {
          const next = prev - 1;
          return next < 0 ? Math.max(0, fileCandidates.length - 1) : next;
        });
        uiLog.event('input:Up', { action: 'file-menu-prev-item' });
        return;
      }
      if (key.return) return;
    }

    // ---- Normal mode (no menu) ----
    // Tab to accept suggestion when input is empty
    if (key.tab && !value) {
      setValue(normalizeInput(suggestion));
      uiLog.event('input:Tab', { action: 'accept-suggestion' });
      return;
    }
    // Ctrl+J / Shift+Enter insert a newline without submitting. InputBox does
    // not expose cursor position to the parent, so append at the end of the prompt.
    if ((key.ctrl && (_input === 'j' || _input === '\n')) || (key.shift && key.return)) {
      setValue(value + '\n');
      setMenuVisible(false);
      setMenuSelected(0);
      setFileMenuVisible(false);
      setFileMention(null);
      setFileCandidates([]);
      setFileSelected(0);
      uiLog.event(key.ctrl ? 'input:Ctrl+J' : 'input:Shift+Enter', { action: 'insert-newline' });
      return;
    }
    // Forward Ctrl-based shortcuts to the parent App. As with Alt chords,
    // restore the pre-event value when consumed to keep shortcut routing defensive.
    if (key.ctrl && onGlobalShortcut) {
      if (onGlobalShortcut(_input, key)) {
        const preservedValue = value;
        queueMicrotask(() => setValue(preservedValue));
        return;
      }
    }
    // Up arrow — navigate history backward
    if (key.upArrow && history.length > 0 && historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setValue(history[newIdx]);
      uiLog.event('input:Up', { action: 'history-back', newIdx });
      return;
    }
    // Down arrow — navigate history forward
    if (key.downArrow && historyIndex >= 0) {
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      setValue(newIdx >= 0 ? history[newIdx] : '');
      uiLog.event('input:Down', { action: 'history-forward', newIdx });
      return;
    }
  });

  const safeOnChange = useCallback((val: string) => {
    const clean = normalizeInput(stripMouseSequences(val));
    setValue(clean);

    // Detect / at start for command menu.
    // Show menu when: starts with /, no space (still typing command name).
    if (clean.startsWith('/') && !clean.includes(' ')) {
      if (!menuVisibleRef.current) {
        uiLog.event('menu:visible', { filter: clean.slice(1) });
      }
      setMenuVisible(true);
      setMenuFilter(clean.slice(1));
      setMenuSelected(0);
      setFileMenuVisible(false);
      setFileMention(null);
      setFileCandidates([]);
      return;
    } else if (clean.startsWith('/') && clean.includes(' ')) {
      // User typed a space after command name — dismiss menu, they're typing args.
      if (menuVisibleRef.current) {
        uiLog.event('menu:hidden', { reason: 'space-after-command' });
      }
      setMenuVisible(false);
    } else {
      if (menuVisibleRef.current) {
        uiLog.event('menu:hidden', { reason: 'leading-slash-removed' });
      }
      setMenuVisible(false);
    }

    const activeMention = findActiveFileMention(clean);
    setFileMention(activeMention);
    setFileCandidates([]);
    setFileSelected(0);
    const showFileMenu = !!activeMention;
    if (showFileMenu && !fileMenuVisibleRef.current) {
      uiLog.event('file-menu:visible', { filter: activeMention.query });
    }
    if (!showFileMenu && fileMenuVisibleRef.current) {
      uiLog.event('file-menu:hidden', { reason: 'no-active-mention' });
    }
    setFileMenuVisible(showFileMenu);
  }, []);

  const handleSubmit = useCallback(
    (val: string) => {
      if (menuVisibleRef.current) {
        const commandValue = getSelectedCommandValue(
          commands,
          menuFilterRef.current,
          menuSelectedRef.current,
        );
        setMenuVisible(false);
        setMenuSelected(0);
        setFileMenuVisible(false);
        setFileMention(null);
        setFileCandidates([]);
        setValue('');
        if (!commandValue) {
          uiLog.event('submit:menu', { result: 'no-command-value' });
          return;
        }
        if (disabled) {
          uiLog.event('submit:menu', {
            result: 'interrupt',
            command: commandValue.slice(1),
            disabled,
          });
          setSubmitFlashKey((key) => key + 1);
          onInterrupt?.();
        } else {
          uiLog.event('submit:menu', {
            result: 'command',
            command: commandValue.slice(1),
          });
          setHistory((h) => [commandValue, ...h].slice(0, 100));
          setHistoryIndex(-1);
          recordCommandUse(commandValue.slice(1));
          setSubmitFlashKey((key) => key + 1);
          onSubmit(commandValue);
        }
        return;
      }

      if (fileMenuVisibleRef.current && acceptSelectedFileMention(val, 'Enter')) {
        return;
      }

      // Dismiss menus on submit.
      setMenuVisible(false);
      setMenuSelected(0);
      setFileMenuVisible(false);
      setFileMention(null);
      setFileCandidates([]);
      setFileSelected(0);

      const normalized = normalizeInput(val);
      if (!normalized.trim()) {
        uiLog.event('submit:text', { result: 'empty' });
        return;
      }
      // While the agent is running, Enter interrupts the stream instead of
      // submitting — input stays live and focusable so the user can act.
      if (disabled) {
        uiLog.event('submit:text', { result: 'interrupt', len: normalized.length });
        setSubmitFlashKey((key) => key + 1);
        onInterrupt?.();
        setValue('');
        return;
      }
      uiLog.event('submit:text', { result: 'submitted', len: normalized.length });
      setHistory((h) => [normalized, ...h].slice(0, 100));
      setHistoryIndex(-1);

      // Track command usage for autocomplete ranking.
      const cmdName = extractCommandName(normalized);
      if (cmdName) recordCommandUse(cmdName);

      setSubmitFlashKey((key) => key + 1);
      onSubmit(normalized);
      setValue('');
    },
    [acceptSelectedFileMention, commands, disabled, onInterrupt, onSubmit],
  );

  const tokenKey = modeColorToken(mode);
  const baseBorderColor = theme[tokenKey];
  const motionDisabled = reducedMotion || screenReader;
  const promptPulse = usePulse(!disabled && !inputSuppressed && !motionDisabled, 700);
  const submitFlash = useTimedFlash(submitFlashKey, 220, motionDisabled);

  const outerWidth = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(outerWidth);
  const editorWidth = Math.max(8, frame.width - 4);
  const inputWidth = Math.max(1, editorWidth - 2);
  const promptColor =
    submitFlash || (promptPulse && !compact) ? theme.brandShimmer : baseBorderColor;
  const placeholder = disabled
    ? compact
      ? 'Enter interrupts'
      : 'Press Enter to interrupt… (or keep typing)'
    : suggestion;

  const selIdx = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));
  const fileSelIdx = Math.max(0, Math.min(fileSelected, fileCandidates.length - 1));

  return (
    <Box flexDirection="column" width={outerWidth}>
      <CommandMenu
        items={filteredCmds}
        filterText={menuFilter}
        selectedIndex={selIdx}
        visible={menuVisible}
        terminalWidth={outerWidth}
        maxRows={maxMenuRows}
        compact={compact}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
      />
      <FileMentionMenu
        items={fileCandidates}
        filterText={fileMention?.query ?? ''}
        selectedIndex={fileSelIdx}
        visible={fileMenuVisible && !menuVisible}
        terminalWidth={outerWidth}
        maxRows={maxMenuRows}
        compact={compact}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
      />

      <Box
        borderStyle="round"
        borderColor={baseBorderColor}
        paddingX={1}
        width={frame.width}
        marginX={frame.marginX}
      >
        <Text color={promptColor}>{screenReader ? '> ' : '› '}</Text>
        <Box width={inputWidth} flexShrink={1}>
          <InputBox
            value={value}
            onChange={safeOnChange}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            // Stay focused while disabled so Enter can route to the interrupt
            // path; only yield to a modal (permission prompt). `focus` here maps
            // to InputBox's internal `useInput` isActive — see inputSuppressed.
            focus={!inputSuppressed}
          />
        </Box>
      </Box>
    </Box>
  );
}
