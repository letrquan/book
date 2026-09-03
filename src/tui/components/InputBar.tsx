import { Box, Text } from 'ink';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import { CommandMenu } from './CommandMenu.js';
import { FileMentionMenu } from './FileMentionMenu.js';
import { SkillMentionMenu } from './SkillMentionMenu.js';
import type { PermissionMode } from '../../types/runtime.js';
import type { ImageAttachment } from '../../types/messages.js';
import type { SlashCommand } from '../../types/commands.js';
import type { Skill } from '../../skills.js';
import { modeColorToken } from '../mode-style.js';
import { isShortcutsToggleKey } from '../tool-presentation.js';
import { frameGrid } from '../layout.js';
import {
  findActiveFileMention,
  getFileMentionCandidates,
  replaceActiveFileMention,
  type ActiveFileMention,
  type FileMentionCandidate,
} from '../../input/file-mentions.js';
import {
  findActiveSkillMention,
  getSkillMentionCandidates,
  replaceActiveSkillMention,
  type ActiveSkillMention,
  type SkillMentionCandidate,
} from '../../input/skill-mentions.js';
import { recordCommandUse } from '../../commands/recent.js';
import {
  getCommandsForEmptyQuery,
  getCommandsForQuery,
  type CommandItem,
} from '../../commands/filter.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { stripSgrMouseSequences } from '../mouse.js';
import { InputBox } from './InputBox.js';

const uiLog = createUiDebugLogger('tui:inputbar');
const FILE_MENTION_DEBOUNCE_MS = 40;

/**
 * Ctrl chords InputBox handles as text edits while the composer holds a draft.
 *
 * Kept here rather than imported from InputBox so the two lists cannot drift
 * apart silently: this is the routing half of the same decision.
 */
const COMPOSER_EDIT_KEYS = new Set(['a', 'e', 'w', 'u', 'k', 'y']);

interface InputBarProps {
  onSubmit: (value: string, attachments?: ImageAttachment[]) => void;
  onPasteImage?: () => Promise<ImageAttachment | null>;
  submissionMode: 'submit' | 'queue' | 'blocked';
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
  /**
   * Whether the thing holding the keyboard is actually asking the user something
   * — a permission prompt, a plan approval, a question, an elicitation.
   *
   * `inputSuppressed` covers that *and* the sheets that merely take the keys
   * while they are open (`/config`, `/model`, the rules list, the task
   * surface). Both silence the composer, but only the first is a prompt, and
   * telling someone to "answer" a settings menu describes a question that is
   * not being asked.
   */
  awaitingAnswer?: boolean;
  /** Allows immediate local commands such as /tasks while the parent is running. */
  canSubmitWhileBusy?: (value: string) => boolean;
  /** Allows conversational input to be queued while the parent is running. */
  canQueueWhileBusy?: (value: string) => boolean;
  /** Receives accepted queued input. Return false when the queue is full. */
  onQueue?: (value: string, attachments?: ImageAttachment[]) => boolean;
  /** Recalls the newest queued input when the composer is empty. */
  onRecallQueued?: () => string | { value: string; attachments?: ImageAttachment[] } | undefined;
  /** Cancels the queued input currently being edited. */
  onCancelQueuedEdit?: () => void;
  /** True while the composer contains a recalled queued input. */
  editingQueuedInput?: boolean;
  /** Keeps the parent aware of the live draft for interrupt restoration. */
  onDraftChange?: (value: string, attachments?: ImageAttachment[]) => void;
  /** Moves focus from an empty prompt to the first background task when available. */
  onFocusBackgroundTask?: () => boolean;
  /**
   * Cycles focus through main + spawned agents on Tab from an empty prompt.
   * Returns false when there are no agents so Tab falls back to its default.
   */
  onCycleAgentFocus?: () => boolean;
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
  /** Discovered skills offered for explicit `$name` invocation. */
  skills?: Skill[];
  /** Keyed request used by conversation rewind to restore a prior prompt draft. */
  draftRestore?: { key: number; value: string; attachments?: ImageAttachment[] };
}

/**
 * Normalize a string to NFC (Canonical Composition) for consistent Unicode handling.
 */
function normalizeInput(value: string): string {
  return value.normalize('NFC');
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

function getSelectedSkillMention(
  candidates: SkillMentionCandidate[],
  selectedIndex: number,
): SkillMentionCandidate | null {
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
  onPasteImage,
  submissionMode,
  mode,
  onCycleMode,
  canSubmitWhileBusy,
  canQueueWhileBusy,
  onQueue,
  onRecallQueued,
  onCancelQueuedEdit,
  editingQueuedInput = false,
  onDraftChange,
  onFocusBackgroundTask,
  onCycleAgentFocus,
  onGlobalShortcut,
  inputSuppressed = false,
  awaitingAnswer = false,
  commands = [],
  skills = [],
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
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | undefined>();
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

  // Skill mention menu state
  const [skillMenuVisible, setSkillMenuVisible] = useState(false);
  const [skillMention, setSkillMention] = useState<ActiveSkillMention | null>(null);
  const [skillSelected, setSkillSelected] = useState(0);
  const skillMenuVisibleRef = useRef(false);
  const skillMentionRef = useRef<ActiveSkillMention | null>(null);
  const skillSelectedRef = useRef(0);
  const skillCandidates = useMemo(
    () => getSkillMentionCandidates(skills, skillMention?.query ?? ''),
    [skillMention?.query, skills],
  );
  const skillCandidatesRef = useRef<SkillMentionCandidate[]>([]);

  useEffect(() => {
    onDraftChange?.(value, attachments.length > 0 ? attachments : undefined);
  }, [attachments, onDraftChange, value]);

  const filteredCmds = useMemo(
    () => getFilteredCommands(commands, menuFilter),
    [commands, menuFilter],
  );
  const resolveSubmissionAction = useCallback(
    (candidate: string): 'submit' | 'queue' | 'blocked' => {
      if (submissionMode === 'submit' || canSubmitWhileBusy?.(candidate)) return 'submit';
      if (submissionMode === 'queue' && (canQueueWhileBusy?.(candidate) ?? true)) return 'queue';
      return 'blocked';
    },
    [canQueueWhileBusy, canSubmitWhileBusy, submissionMode],
  );
  const workspace = process.env.BOOK_WORKSPACE || process.cwd();

  const pasteImage = useCallback(() => {
    if (!onPasteImage) return;
    void onPasteImage()
      .then((attachment) => {
        if (!attachment) return;
        setAttachmentError(undefined);
        setAttachments((current) => {
          if (current.length >= 4) {
            setAttachmentError('At most 4 images can be attached to one message.');
            return current;
          }
          return [...current, attachment];
        });
      })
      .catch((error) => {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      });
  }, [onPasteImage]);

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
  skillMenuVisibleRef.current = skillMenuVisible;
  skillMentionRef.current = skillMention;
  skillSelectedRef.current = skillSelected;
  skillCandidatesRef.current = skillCandidates;

  useEffect(() => {
    if (!draftRestore) return;
    setValue(normalizeInput(draftRestore.value));
    setAttachments(draftRestore.attachments ?? []);
    setHistoryIndex(-1);
    setMenuVisible(false);
    setMenuSelected(0);
    setFileMenuVisible(false);
    setFileMention(null);
    setFileCandidates([]);
    setFileSelected(0);
    setSkillMenuVisible(false);
    setSkillMention(null);
    setSkillSelected(0);
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

  const acceptSelectedSkillMention = useCallback(
    (currentValue: string, trigger: 'Tab' | 'Enter'): boolean => {
      const mention = skillMentionRef.current;
      const selected = getSelectedSkillMention(
        skillCandidatesRef.current,
        skillSelectedRef.current,
      );
      if (!mention || !selected) return false;

      const nextValue = replaceActiveSkillMention(currentValue, mention, selected.name);
      setValue(nextValue);
      setSkillMention(null);
      setSkillMenuVisible(false);
      setSkillSelected(0);
      uiLog.event(`input:${trigger}`, { action: 'autofill-skill-mention', skill: selected.name });
      return true;
    },
    [],
  );

  useInput((_input, key) => {
    // TranscriptView owns mouse reports. Drop them before menu/history routing
    // so wheel movement, clicks, and drags cannot reach the prompt draft.
    if (_input.startsWith('[<') || _input.startsWith('\x1b[<')) return;

    // While a modal (permission prompt) owns the keyboard, ignore all keys —
    // PermissionButtons handles them. Without this, Ink fires every `useInput`
    // handler on every keypress, so Enter/Tab/Esc would double-fire.
    if (inputSuppressed) return;
    if (key.meta && _input.toLowerCase() === 'v') {
      pasteImage();
      return;
    }
    // Alt+Backspace is a composer edit, not a shortcut: InputBox deletes the
    // previous word, and restoring the pre-event value here would undo it.
    if (key.meta && (key.backspace || key.delete)) return;
    // Filter out Alt/Meta-modified keys — they're shortcuts, not text input.
    // Preserve the editor value while the parent handles Alt/Meta shortcuts.
    if (key.meta) {
      const preservedValue = value;
      queueMicrotask(() => setValue(preservedValue));
      return;
    }

    if (key.backspace && !value && attachments.length > 0) {
      setAttachments((current) => current.slice(0, -1));
      setAttachmentError(undefined);
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

    // ---- Explicit skill mention menu keyboard handling ----
    if (skillMenuVisible) {
      if (key.escape) {
        setSkillMenuVisible(false);
        setSkillMention(null);
        setSkillSelected(0);
        uiLog.event('input:Escape', { action: 'dismiss-skill-menu' });
        return;
      }
      if (key.tab) {
        acceptSelectedSkillMention(value, 'Tab');
        return;
      }
      if (key.downArrow) {
        setSkillSelected((prev) => {
          const next = prev + 1;
          return next >= skillCandidates.length ? 0 : next;
        });
        return;
      }
      if (key.upArrow) {
        setSkillSelected((prev) => {
          const next = prev - 1;
          return next < 0 ? Math.max(0, skillCandidates.length - 1) : next;
        });
        return;
      }
      if (key.return) return;
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

    if (key.escape && editingQueuedInput) {
      setValue('');
      setHistoryIndex(-1);
      onCancelQueuedEdit?.();
      uiLog.event('input:Escape', { action: 'cancel-queued-edit' });
      return;
    }

    // ---- Normal mode (no menu) ----
    // Tab from an empty prompt cycles focus through main + spawned agents
    // (Claude-Code-style flat switching). Falls back to accepting the
    // placeholder suggestion when there are no agents to cycle.
    if (key.tab && !value) {
      if (onCycleAgentFocus?.()) {
        uiLog.event('input:Tab', { action: 'cycle-agent-focus' });
        return;
      }
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
    // A draft in the composer claims the readline chords for editing; an empty
    // one leaves them to the transcript, where Ctrl+E expands a tool and
    // Ctrl+U scrolls. Forwarding them while there is text to edit would let the
    // parent consume the key and then restore the pre-event value, undoing the
    // edit InputBox just made.
    if (key.ctrl && value.length > 0 && COMPOSER_EDIT_KEYS.has(_input.toLowerCase())) return;
    // Forward Ctrl-based shortcuts to the parent App. As with Alt chords,
    // restore the pre-event value when consumed to keep shortcut routing defensive.
    // Ctrl+/ arrives as a bare US byte with no `ctrl` flag (see
    // `isShortcutsToggleKey`), so gating on `key.ctrl` alone would swallow it here.
    if ((key.ctrl || isShortcutsToggleKey(_input, key)) && onGlobalShortcut) {
      if (onGlobalShortcut(_input, key)) {
        const preservedValue = value;
        queueMicrotask(() => setValue(preservedValue));
        return;
      }
    }
    // Claude Code-style task access: Down from a fresh, empty prompt moves
    // focus into the task list. Enter is then handled by SubagentPanel.
    if (key.downArrow && !value && historyIndex < 0 && onFocusBackgroundTask?.()) {
      uiLog.event('input:Down', { action: 'focus-background-task' });
      return;
    }
    if (key.upArrow && !value) {
      const recalled = onRecallQueued?.();
      if (recalled !== undefined) {
        setHistoryIndex(-1);
        if (typeof recalled === 'string') {
          setValue(recalled);
        } else {
          setValue(recalled.value);
          setAttachments(recalled.attachments ?? []);
        }
        uiLog.event('input:Up', { action: 'recall-queued-input' });
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
    const clean = normalizeInput(stripSgrMouseSequences(val));
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
      setSkillMenuVisible(false);
      setSkillMention(null);
      setSkillSelected(0);
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

    const activeSkillMention = findActiveSkillMention(clean);
    if (activeSkillMention) {
      if (!skillMenuVisibleRef.current) {
        uiLog.event('skill-menu:visible', { filter: activeSkillMention.query });
      }
      setSkillMention(activeSkillMention);
      setSkillSelected(0);
      setSkillMenuVisible(true);
      setFileMenuVisible(false);
      setFileMention(null);
      setFileCandidates([]);
      setFileSelected(0);
      return;
    }
    if (skillMenuVisibleRef.current) {
      uiLog.event('skill-menu:hidden', { reason: 'no-active-mention' });
    }
    setSkillMenuVisible(false);
    setSkillMention(null);
    setSkillSelected(0);

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
        if (!commandValue) {
          setValue('');
          uiLog.event('submit:menu', { result: 'no-command-value' });
          return;
        }
        const action = resolveSubmissionAction(commandValue);
        if (action === 'blocked') {
          uiLog.event('submit:menu', {
            result: 'blocked',
            command: commandValue.slice(1),
            submissionMode,
          });
          setValue(commandValue);
        } else if (action === 'queue') {
          const accepted = onQueue?.(commandValue) ?? false;
          uiLog.event('submit:menu', {
            result: accepted ? 'queued' : 'queue-full',
            command: commandValue.slice(1),
          });
          setValue(accepted ? '' : commandValue);
        } else {
          uiLog.event('submit:menu', {
            result: 'command',
            command: commandValue.slice(1),
          });
          setHistory((h) => [commandValue, ...h].slice(0, 100));
          setHistoryIndex(-1);
          recordCommandUse(commandValue.slice(1));
          onSubmit(commandValue);
          setValue('');
        }
        return;
      }

      if (skillMenuVisibleRef.current && acceptSelectedSkillMention(val, 'Enter')) {
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
      setSkillMenuVisible(false);
      setSkillMention(null);
      setSkillSelected(0);

      const normalized = normalizeInput(val);
      if (!normalized.trim() && attachments.length === 0) {
        uiLog.event('submit:text', { result: 'empty' });
        return;
      }
      if (normalized.trimStart().startsWith('/') && attachments.length > 0) {
        setAttachmentError('Image attachments cannot be combined with slash commands.');
        return;
      }
      const action = resolveSubmissionAction(normalized);
      if (action === 'blocked') {
        uiLog.event('submit:text', { result: 'blocked', len: normalized.length, submissionMode });
        return;
      }
      if (action === 'queue') {
        const accepted =
          attachments.length > 0
            ? (onQueue?.(normalized, attachments) ?? false)
            : (onQueue?.(normalized) ?? false);
        uiLog.event('submit:text', {
          result: accepted ? 'queued' : 'queue-full',
          len: normalized.length,
        });
        if (!accepted) return;
      } else {
        uiLog.event('submit:text', { result: 'submitted', len: normalized.length });
      }
      setHistory((h) => [normalized, ...h].slice(0, 100));
      setHistoryIndex(-1);

      // Track command usage for autocomplete ranking.
      const cmdName = extractCommandName(normalized);
      if (cmdName) recordCommandUse(cmdName);

      if (action === 'submit') {
        if (attachments.length > 0) onSubmit(normalized, attachments);
        else onSubmit(normalized);
      }
      setValue('');
      setAttachments([]);
      setAttachmentError(undefined);
    },
    [
      acceptSelectedFileMention,
      acceptSelectedSkillMention,
      commands,
      onQueue,
      onSubmit,
      resolveSubmissionAction,
      submissionMode,
      attachments,
      pasteImage,
    ],
  );

  const tokenKey = modeColorToken(mode);
  const baseBorderColor = theme[tokenKey];

  const outerWidth = Math.max(20, Math.floor(terminalWidth));
  // The composer spans the transcript rather than floating over it, so it takes
  // the full terminal like the rows above it -- not the bounded panel measure.
  const frame = frameGrid(outerWidth);
  const editorWidth = Math.max(8, frame.width - 4);
  const inputWidth = Math.max(1, editorWidth - 2);
  const promptColor = baseBorderColor;
  // A modal owns the keyboard, so the composer accepts nothing — saying
  // "Type a follow-up" here invited the user to type into a locked field while
  // the prompt above was reading their keystrokes as answers. Which of the two
  // things is holding the keys decides what to say instead: a prompt wants an
  // answer, a sheet just wants closing, and every sheet that suppresses input
  // closes on Esc.
  const placeholder = inputSuppressed
    ? awaitingAnswer
      ? compact
        ? 'Answer above'
        : 'Answer the prompt above'
      : compact
        ? 'Esc closes'
        : 'Esc closes this'
    : submissionMode === 'queue'
      ? compact
        ? 'Enter queues'
        : 'Type a follow-up; Enter queues it'
      : submissionMode === 'blocked'
        ? compact
          ? 'Please wait...'
          : 'Input is temporarily unavailable'
        : suggestion;

  const selIdx = Math.max(0, Math.min(menuSelected, filteredCmds.length - 1));
  const fileSelIdx = Math.max(0, Math.min(fileSelected, fileCandidates.length - 1));
  const skillSelIdx = Math.max(0, Math.min(skillSelected, skillCandidates.length - 1));

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
      <SkillMentionMenu
        items={skillCandidates}
        filterText={skillMention?.query ?? ''}
        selectedIndex={skillSelIdx}
        visible={skillMenuVisible && !menuVisible}
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
        visible={fileMenuVisible && !menuVisible && !skillMenuVisible}
        terminalWidth={outerWidth}
        maxRows={maxMenuRows}
        compact={compact}
        reducedMotion={reducedMotion}
        screenReader={screenReader}
      />

      {attachments.length > 0 ? (
        <Box marginX={frame.marginX} paddingX={1}>
          <Text color={theme.brand}>
            {attachments.map(
              (attachment, index) =>
                `${index > 0 ? '  ' : ''}[image ${index + 1} ${(attachment.byteSize / 1024).toFixed(0)} KB]`,
            )}
          </Text>
        </Box>
      ) : null}
      {attachmentError ? (
        <Text color={theme.warning} wrap="wrap">
          Image paste failed: {attachmentError}
        </Text>
      ) : null}

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
            // Stay focused while busy so Enter can queue a follow-up; only yield
            // to a modal (permission prompt). `focus` here maps
            // to InputBox's internal `useInput` isActive — see inputSuppressed.
            focus={!inputSuppressed}
          />
        </Box>
      </Box>
    </Box>
  );
}
