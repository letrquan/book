import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';
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
}

/**
 * Normalize a string to NFC (Canonical Composition) for consistent Unicode handling.
 *
 * Vietnamese and other languages with diacritics can be represented in two forms:
 *   NFC (precomposed):  ắ = U+1EAF (single codepoint)
 *   NFD (decomposed):   ắ = a + U+031B (horn) + U+0301 (acute) (3 codepoints)
 *
 * Different terminals/IMEs emit different forms. Normalizing to NFC ensures
 * text renders, stores, and transmits consistently regardless of input method.
 */
function normalizeInput(value: string): string {
  return value.normalize('NFC');
}

/**
 * Strip SGR mouse escape sequences that leak through from ink-text-input.
 *
 * ink-text-input v6.0.0 has its own internal useInput listener that runs
 * independently of ours — it receives SGR mouse events and injects them as
 * literal text. We can't stop it at the event level (Node EventEmitter calls
 * all listeners), so we filter at the value level instead.
 *
 * Ink's useInput/parseKeypress strips the leading ESC byte, so SGR sequences
 * arrive as "[<64;col;rowM" (press) or "[<0;col;rowm" (release).
 */
function stripMouseSequences(val: string): string {
  // After Ink's parseKeypress strips the leading ESC byte, SGR mouse
  // sequences arrive as "[<64;col;rowM" or "[<0;col;rowm".
  // The regex matches: literal "[<" + digits/semicolons + "M" or "m".
  return val.replace(/\[<[0-9;]*[Mm]/g, '');
}

/**
 * Claude Code-style input bar.
 *
 * The prompt stays visible and interactive at all times — even while the
 * agent is streaming. Users can type their next message ahead; only
 * submission is gated when disabled.
 *
 * Supports:
 *   @path     — expand to file contents (up to 2000 chars)
 *   !cmd      — run shell command and insert output
 *   Shift+Enter — insert newline (multiline input)
 *   Tab       — accept suggestion when input is empty
 *   Shift+Tab — cycle permission mode
 *   Vietnamese — full Unicode NFC normalization for diacritics (ắ, ễ, ệ, ạ, ớ, ứ, ổ, …)
 */
export function InputBar({ onSubmit, disabled, mode, onCycleMode, onGlobalShortcut }: InputBarProps) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const suggestion = 'Ask me anything...';
  const inputRef = useRef<any>(null);

  useInput((_input, key) => {
    // Filter out Alt/Meta-modified keys — they're shortcuts, not text input.
    // e.g. Alt+M cycles mode but shouldn't write "m" into the input.
    if (key.meta) return;

    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }
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
    // Note: SGR/X10 mouse sequences are NOT filtered here because
    // ink-text-input has its own internal useInput listener that we
    // cannot prevent from firing. Filtering happens at the value level
    // via safeOnChange instead — it strips any leaked sequences.
  });

  /**
   * Value-level filter for mouse sequences that leak through ink-text-input.
   *
   * ink-text-input's internal useInput injects unrecognized escape sequences
   * as literal text. We strip them here so the user never sees garbage.
   */
  const safeOnChange = useCallback((val: string) => {
    const clean = stripMouseSequences(val);
    setValue(clean);
  }, []);

  const handleSubmit = useCallback(
    (val: string) => {
      // Normalize to NFC so Vietnamese diacritics (ắ, ễ, ệ, ạ, ớ, ứ, ổ, …)
      // are represented consistently regardless of terminal/IME decomposition.
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

  // Build a full-width divider line matching the terminal width.
  const { stdout } = useStdout();
  const divider = useMemo(() => {
    const width = stdout?.columns ?? 80;
    return '─'.repeat(Math.max(5, width - 2));
  }, [stdout?.columns]);

  return (
    <Box flexDirection="column">
      <Text color={theme.subtle}>{divider}</Text>
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
