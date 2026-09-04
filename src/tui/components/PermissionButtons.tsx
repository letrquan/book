import { Box, Text, useInput } from 'ink';
import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, PANEL_CHROME, frameGrid } from '../layout.js';
import { useDensityMetrics } from '../density.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import { isFileMutatingTool } from '../../tools/tool-capabilities.js';
import {
  isPreviewableMutation,
  previewMutation,
  type MutationPreview,
} from '../../tools/mutation-preview.js';
import { permissionRuleForToolCall, permissionRuleLadder } from '../../permissions.js';
import type { PermissionDecision, PermissionResult, ToolCall } from '../../types/tools.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { DiffBlock } from './Diff.js';
import { displayWidth, hardWrapLine, truncateDisplay } from './word-wrap.js';

const uiLog = createUiDebugLogger('tui:permbtn');
const PERMISSION_PATTERN_DISPLAY_MAX_LENGTH = 40;

/**
 * Rows the payload (a wrapped command, or a diff) may take before the card
 * marks a cut. The prompt sits under the transcript, so a bound is still
 * wanted — but it is a bound on rows the terminal can show, never a fixed
 * character count, and every cut is marked and can be opened with `D`.
 */
const COLLAPSED_COMMAND_ROWS = 6;
const COLLAPSED_DIFF_ROWS = 8;
/** Rows the card keeps free for its own chrome, the buttons, and the composer. */
const RESERVED_ROWS = 12;
const MIN_DIFF_ROWS_PER_FILE = 4;

/**
 * Marks the armed button, the same way {@link PlanApprovalActions} marks its own.
 *
 * The armed choice used to be carried by background colour and bold alone: the
 * only selection surface in the TUI without a glyph, while every menu, picker
 * and wizard has one. That was already an accessibility problem — a low-contrast
 * theme or a colour-blind reader has nothing left — and it got worse when `A`
 * became the way to *arm* "Always allow" and then step its scope rather than
 * fire it, because the whole interaction now depends on seeing which button is
 * armed. The brackets went with it: a marker and a pair of brackets are two
 * containers doing one job, and dropping them buys back columns the rule
 * pattern needs.
 */
const SELECTION_MARKER = '▸';

interface PermissionButtonsProps {
  toolCall: ToolCall;
  /**
   * Receives the decision. `always` carries the rule the user actually chose,
   * which is not always the exact command: the scope ladder lets them widen it.
   */
  onResolve: (decision: PermissionResult | PermissionDecision) => void;
  /** When true, disables all animations/colors for screen readers. */
  screenReader?: boolean;
  /** Terminal columns; the payload wraps to the card's interior. */
  terminalWidth?: number;
  /** Terminal rows; bounds how much of the payload `D` may open. */
  terminalRows?: number;
  /**
   * Workspace the pending call would mutate. When set, file mutations show
   * the diff they would produce before anything is written; without it the
   * card can only name the path.
   */
  workspaceRoot?: string;
}

interface ButtonDef {
  label: string;
  value: PermissionResult;
  key: string;
  colorKey: 'permission' | 'remember' | 'subtle';
}

const BUTTONS: ButtonDef[] = [
  { label: 'Run once', value: 'allow', key: 'r', colorKey: 'permission' },
  { label: 'Skip', value: 'deny', key: 's', colorKey: 'subtle' },
  { label: 'Always allow', value: 'always', key: 'a', colorKey: 'remember' },
];

export function toolRiskLevel(toolCall: ToolCall): 'safe' | 'network' | 'write' | 'shell' {
  const name = canonicalToolName(toolCall.name);
  const lower = toolCall.name.toLowerCase();
  if (name === 'Bash' || name === 'KillShell' || lower.includes('bash') || lower === 'shell')
    return 'shell';
  if (isFileMutatingTool(name)) return 'write';
  if (name === 'WebFetch' || name === 'WebSearch') return 'network';
  return 'safe';
}

function riskHint(level: ReturnType<typeof toolRiskLevel>): string | null {
  if (level === 'shell') return 'This will run a shell command on your machine.';
  if (level === 'write') return 'This will modify files on disk.';
  if (level === 'network') return 'This will send a request to an external service.';
  return null;
}

export function permissionPatternForTool(toolCall: ToolCall, primaryArg: string): string {
  void primaryArg;
  return permissionRuleForToolCall(toolCall);
}

/** Caption for a scope the user has widened past the exact command. */
export function scopeCaption(ladder: readonly string[], index: number): string | null {
  if (index === 0) return null;
  const remaining = ladder.length - 1 - index;
  return remaining > 0
    ? `Covers every command matching this pattern. A again widens further.`
    : `Covers every command matching this pattern. A again returns to the exact one.`;
}

export function permissionPatternForDisplay(pattern: string): string {
  if (pattern.length <= PERMISSION_PATTERN_DISPLAY_MAX_LENGTH) return pattern;
  return `${pattern.slice(0, PERMISSION_PATTERN_DISPLAY_MAX_LENGTH - 3)}...`;
}

/**
 * The text the user is consenting to. For a shell command that is the whole
 * command, every line of it: {@link getPrimaryArg} keeps only the first line
 * because it serves rule matching, and a prompt built on it showed
 * `cd x &&` for a script whose second line was the `rm`.
 */
export function permissionPayloadText(toolCall: ToolCall): string {
  const command = toolCall.arguments?.command;
  if (typeof command === 'string') return command;
  return getPrimaryArg(toolCall.arguments ?? {});
}

export interface WrappedPayload {
  /** Rows to draw, already cut to the budget. */
  rows: string[];
  /** Rows the budget hid; `0` when the payload fits. */
  hiddenRows: number;
}

/**
 * Wrap a payload to `width` columns and cut it to `maxRows` rows.
 *
 * A hard wrap, not a word wrap: a command's spacing is part of the command,
 * and a display that collapses `"a  b"` to `"a b"` shows something the shell
 * will not run. The cut always leaves room for its own marker, so a reader can
 * tell a payload that fits from one that was trimmed.
 */
export function wrapPayload(text: string, width: number, maxRows: number): WrappedPayload {
  const columns = Math.max(4, Math.floor(width));
  const rows = text.split('\n').flatMap((line) => hardWrapLine(line, columns));
  const budget = Math.max(1, Math.floor(maxRows));
  if (rows.length <= budget) return { rows, hiddenRows: 0 };
  // The marker takes a row of its own, so one fewer payload row survives.
  const kept = Math.max(1, budget - 1);
  return { rows: rows.slice(0, kept), hiddenRows: rows.length - kept };
}

type PreviewState =
  { status: 'idle' } | { status: 'loading' } | { status: 'ready'; preview: MutationPreview };

function previewSummary(preview: MutationPreview): string {
  const added = preview.files.reduce((total, file) => total + file.stats.addedLines, 0);
  const removed = preview.files.reduce((total, file) => total + file.stats.removedLines, 0);
  return `+${added} −${removed}`;
}

function fileKindLabel(kind: 'create' | 'update' | 'delete'): string {
  return kind === 'create' ? 'create' : kind === 'delete' ? 'delete' : 'update';
}

/**
 * Permission prompt card.
 *
 * Navigation:
 *   ←/→ or Tab/Shift+Tab — cycle between buttons
 *   Enter, or R/S — activate; A selects "Always allow" without activating it
 *   D — open or close the rest of a cut payload (command rows, diff rows)
 *   Esc — deny
 */
export function PermissionButtons({
  toolCall,
  onResolve,
  screenReader = false,
  terminalWidth = 80,
  terminalRows = 24,
  workspaceRoot,
}: PermissionButtonsProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  // Enter reads the selection through `currentSelected()`, not from render
  // state. `A` now only arms "Always allow", so `A` then a quick Enter lands in
  // one React batch and an Enter handler closing over render state would still
  // see the previous index — resolving `allow` when the user asked for
  // `always`.
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const resolvedToolCallIdRef = useRef<string | null>(null);
  const canonical = canonicalToolName(toolCall.name);
  const primaryArg = getPrimaryArg(toolCall.arguments);
  const payload = permissionPayloadText(toolCall);
  const risk = toolRiskLevel(toolCall);
  const hint = riskHint(risk);
  // The rules "Always allow" may write, narrowest first. For a shell command
  // the exact rule matches that byte sequence and nothing else, so offering
  // only that made the button a no-op for the case it exists to serve; the user
  // steps the scope with `A` and always sees the pattern before Enter writes it.
  const ladder = useMemo(() => permissionRuleLadder(toolCall), [toolCall]);
  const ladderRef = useRef(ladder);
  ladderRef.current = ladder;
  const [scopeIndex, setScopeIndex, currentScope] = useKeyState(0);
  const alwaysPattern = ladder[scopeIndex] ?? ladder[0];
  const alwaysPatternDisplay = permissionPatternForDisplay(alwaysPattern);
  const scopeHint = scopeCaption(ladder, scopeIndex);
  const [expanded, setExpanded] = useState(false);

  // The card is a bordered surface flush at column 0, like the composer, so
  // its border plus padding land its text on the content column.
  const frame = frameGrid(Math.max(20, Math.floor(terminalWidth)));
  const contentWidth = Math.max(8, frame.width - PANEL_CHROME);
  // Visual rows the payload may spend once `D` opens it. The card lives in
  // the fixed region under the transcript, so a payload taller than the
  // terminal pushes its own buttons off the top of the screen.
  const rowBudget = Math.max(COLLAPSED_DIFF_ROWS, Math.floor(terminalRows) - RESERVED_ROWS);
  // A change-focused diff draws a `⋮ n rows omitted` marker between every run
  // of selected rows, so in the worst case each budgeted row costs two on
  // screen; the diff budget is the row budget halved.
  const expandedDiffRows = Math.max(MIN_DIFF_ROWS_PER_FILE, Math.floor(rowBudget / 2));
  const collapsedDiffRows = Math.min(COLLAPSED_DIFF_ROWS, expandedDiffRows);

  // The header carries the payload inline only when the whole thing fits on
  // that row; otherwise the payload takes rows of its own under it, wrapped
  // to the card. A fixed 72-character slice used to hide the tail of every
  // longer command with nothing to mark the cut.
  const header = `Permission required · ${canonical}`;
  const inlineRoom = contentWidth - displayWidth(header) - 1;
  const payloadInline =
    payload.length > 0 && !payload.includes('\n') && displayWidth(payload) <= inlineRoom;
  const wrappedPayload = useMemo(
    () =>
      payloadInline || payload.length === 0
        ? { rows: [], hiddenRows: 0 }
        : wrapPayload(payload, contentWidth, expanded ? rowBudget : COLLAPSED_COMMAND_ROWS),
    [contentWidth, expanded, payload, payloadInline, rowBudget],
  );

  // File mutations show the diff they would make, computed from the pending
  // arguments against the file on disk. Nothing is written until the user
  // answers; the tool recomputes against the file it finds when it runs.
  const previewable = Boolean(workspaceRoot) && isPreviewableMutation(toolCall);
  const [previewState, setPreviewState] = useState<PreviewState>(
    previewable ? { status: 'loading' } : { status: 'idle' },
  );
  useEffect(() => {
    if (!previewable || !workspaceRoot) {
      setPreviewState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setPreviewState({ status: 'loading' });
    previewMutation(toolCall, workspaceRoot, controller.signal)
      .then((preview) => {
        if (controller.signal.aborted) return;
        setPreviewState(preview ? { status: 'ready', preview } : { status: 'idle' });
        uiLog.event('preview', {
          tool: canonical,
          files: preview?.files.length ?? 0,
          error: preview?.error ?? '',
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewState({
          status: 'ready',
          preview: {
            files: [],
            error: `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      });
    return () => controller.abort();
  }, [canonical, previewable, toolCall, workspaceRoot]);

  const preview = previewState.status === 'ready' ? previewState.preview : null;
  const diffFiles = preview?.files.filter((file) => file.diff.length > 0) ?? [];
  const diffRowsPerFile =
    diffFiles.length === 0
      ? 0
      : Math.max(
          MIN_DIFF_ROWS_PER_FILE,
          Math.floor((expanded ? expandedDiffRows : collapsedDiffRows) / diffFiles.length),
        );
  const diffRowsTotal = diffFiles.reduce((total, file) => total + file.diff.split('\n').length, 0);
  // `D` is offered only while it would show something more, or has. On a
  // terminal too short for a larger budget the diff already shows what it can.
  const diffHasMore = diffRowsTotal > diffRowsPerFile * Math.max(1, diffFiles.length);
  const canExpand =
    expanded ||
    wrappedPayload.hiddenRows > 0 ||
    (diffHasMore && expandedDiffRows > collapsedDiffRows);

  // Track previous selection for old→new logging without stale closure issues.
  const prevSelectedRef = useRef(0);

  useDebugMount(uiLog, {
    tool: canonical,
    risk,
    primaryArg: primaryArg ? primaryArg.slice(0, 40) : null,
  });

  const moveSelection = useCallback((next: (current: number) => number) => {
    setSelected(next(currentSelected()));
  }, []);

  const handleResolve = useCallback(
    (value: PermissionResult) => {
      if (resolvedToolCallIdRef.current === toolCall.id) {
        uiLog.event('resolve:double-fire-prevented', {
          tool: canonical,
          attempt: value,
        });
        return;
      }
      resolvedToolCallIdRef.current = toolCall.id;
      const rule = value === 'always' ? ladderRef.current[currentScope()] : undefined;
      uiLog.event('resolve', {
        tool: canonical,
        result: value,
        selected,
        rule: rule ?? '',
      });
      onResolve(rule ? { result: value, rule } : value);
    },
    [canonical, onResolve, selected, toolCall.id],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow) {
        const prev = selected;
        moveSelection((s) => (s - 1 + BUTTONS.length) % BUTTONS.length);
        uiLog.event('input:Left', { tool: canonical, selected: `${prev}->?` });
        return;
      }
      if (key.rightArrow) {
        const prev = selected;
        moveSelection((s) => (s + 1) % BUTTONS.length);
        uiLog.event('input:Right', { tool: canonical, selected: `${prev}->?` });
        return;
      }
      if (key.tab) {
        const prev = selected;
        moveSelection((s) =>
          key.shift ? (s - 1 + BUTTONS.length) % BUTTONS.length : (s + 1) % BUTTONS.length,
        );
        uiLog.event('input:Tab', { tool: canonical, shift: key.shift, selected: `${prev}->?` });
        return;
      }
      // Enter only. Space used to activate too, which put `always` two ordinary
      // keystrokes away — `a` then a space, the opening of any sentence
      // starting with "a " — and the card advertises Enter, never space.
      if (key.return) {
        const armed = currentSelected();
        uiLog.event('input:Enter', {
          tool: canonical,
          selected: armed,
          rule: BUTTONS[armed].value === 'always' ? ladder[currentScope()] : undefined,
        });
        handleResolve(BUTTONS[armed].value);
        return;
      }
      if (key.escape) {
        uiLog.event('input:Escape', { tool: canonical, action: 'deny' });
        handleResolve('deny');
        return;
      }
      if (input === 'r' || input === 'R') {
        uiLog.event('input:shortcut', { tool: canonical, key: 'R', action: 'allow' });
        handleResolve('allow');
        return;
      }
      if (input === 's' || input === 'S') {
        uiLog.event('input:shortcut', { tool: canonical, key: 'S', action: 'deny' });
        handleResolve('deny');
        return;
      }
      // `D` only changes what the card shows, never what it resolves, so a
      // stray press costs nothing.
      if (input === 'd' || input === 'D') {
        setExpanded((current) => {
          uiLog.event('input:shortcut', {
            tool: canonical,
            key: 'D',
            action: current ? 'collapse-detail' : 'expand-detail',
          });
          return !current;
        });
        return;
      }
      // `A` deliberately has no single-key shortcut. `always` is the one choice
      // here that writes a permission rule to disk, and rules can only be
      // removed by hand, so it must not be reachable by one stray letter — a
      // lone `a` used to grant a persistent shell allow with no visible trace.
      // Select it and press Enter.
      if (input === 'a' || input === 'A') {
        const alwaysIndex = BUTTONS.findIndex((button) => button.value === 'always');
        // First `A` arms the button; each `A` after that widens the scope and
        // wraps back to the exact rule, so the key can explore every option
        // without ever committing one.
        if (currentSelected() === alwaysIndex && ladder.length > 1) {
          setScopeIndex((currentScope() + 1) % ladder.length);
          uiLog.event('input:shortcut', {
            tool: canonical,
            key: 'A',
            action: 'step-scope',
            rule: ladder[currentScope()],
          });
          return;
        }
        uiLog.event('input:shortcut', { tool: canonical, key: 'A', action: 'select-always' });
        moveSelection(() => alwaysIndex);
        return;
      }
    },
    { isActive: true },
  );

  // Log the resolved selection change with old→new after render.
  useEffect(() => {
    if (prevSelectedRef.current !== selected) {
      uiLog.event('selection:change', {
        tool: canonical,
        from: prevSelectedRef.current,
        to: selected,
      });
      prevSelectedRef.current = selected;
    }
  }, [selected, canonical]);

  if (screenReader) {
    return (
      <Box marginLeft={CONTENT_COLUMN} flexDirection="column">
        <Text>Permission required for: {canonical}</Text>
        {risk === 'shell' && payload ? (
          <Text>Command: {payload}</Text>
        ) : (
          <Text>Primary argument: {primaryArg || '(none)'}</Text>
        )}
        {hint ? <Text>Warning: {hint}</Text> : null}
        {previewState.status === 'loading' ? <Text>Computing the change preview.</Text> : null}
        {preview?.error ? <Text>Cannot preview this change: {preview.error}</Text> : null}
        {preview?.files.map((file) => (
          <Text key={file.filePath}>
            Will {fileKindLabel(file.kind)} {file.filePath}: {file.stats.addedLines} lines added,{' '}
            {file.stats.removedLines} lines removed.
          </Text>
        ))}
        <Text>Press: [R] Run once, [S] Skip, [Esc] Deny.</Text>
        <Text>Always allow: press [A] to select it, then Enter to confirm.</Text>
        <Text>Rule to be saved: {alwaysPattern}</Text>
        {ladder.length > 1 ? <Text>Press [A] again to widen or narrow that rule.</Text> : null}
      </Box>
    );
  }

  const helpKeys = [
    '← → select',
    'Enter confirm',
    ladder.length > 1 ? 'A scope' : null,
    canExpand ? (expanded ? 'D less' : 'D more') : null,
    'R run',
    'S skip',
    'Esc deny',
  ].filter((entry): entry is string => entry !== null);

  return (
    <Box
      marginLeft={frame.marginX}
      width={frame.width}
      flexDirection="column"
      borderStyle="round"
      borderColor={
        risk === 'shell' ? theme.error : risk === 'write' ? theme.warning : theme.permission
      }
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.permission}>
          Permission required ·{' '}
        </Text>
        <Text bold color={theme.brand}>
          {canonical}
        </Text>
        {payloadInline ? <Text color={theme.text}> {payload}</Text> : null}
      </Box>
      {wrappedPayload.rows.map((row, index) => (
        <Box key={index}>
          <Text color={theme.text}>{row}</Text>
        </Box>
      ))}
      {wrappedPayload.hiddenRows > 0 ? (
        <Box>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(
              `… ${wrappedPayload.hiddenRows} more ${wrappedPayload.hiddenRows === 1 ? 'row' : 'rows'}${expanded ? '' : ' · D shows all'}`,
              contentWidth,
            )}
          </Text>
        </Box>
      ) : null}
      {hint ? (
        <Box>
          <Text color={risk === 'shell' ? theme.error : theme.warning}>{hint}</Text>
        </Box>
      ) : null}
      {previewState.status === 'loading' ? (
        <Box>
          <Text color={theme.subtle} dimColor>
            Computing diff…
          </Text>
        </Box>
      ) : null}
      {preview?.error ? (
        <Box>
          <Text color={theme.warning}>
            {truncateDisplay(`Cannot preview: ${preview.error}`, contentWidth)}
          </Text>
        </Box>
      ) : null}
      {preview && !preview.error && preview.files.length > 0 ? (
        <Box flexDirection="column">
          {preview.files.map((file) => (
            <Box key={file.filePath} flexDirection="column">
              <Box>
                <Text color={theme.subtle} dimColor>
                  {fileKindLabel(file.kind)}{' '}
                </Text>
                <Text color={theme.text}>
                  {truncateDisplay(file.filePath, Math.max(8, contentWidth - 20))}
                </Text>
                <Text> </Text>
                <Text color={theme.success}>+{file.stats.addedLines}</Text>
                <Text> </Text>
                <Text color={theme.error}>−{file.stats.removedLines}</Text>
                {file.diff.length === 0 ? (
                  <Text color={theme.subtle} dimColor>
                    {' '}
                    no textual change
                  </Text>
                ) : null}
              </Box>
              {file.diff.length > 0 ? (
                <DiffBlock
                  output={file.diff}
                  filePath={file.filePath}
                  collapsed
                  maxRows={diffRowsPerFile}
                  expandHint={canExpand && !expanded ? 'D shows more' : ''}
                  terminalWidth={contentWidth}
                />
              ) : null}
            </Box>
          ))}
          {preview.files.length > 1 ? (
            <Box>
              <Text color={theme.subtle} dimColor>
                {preview.files.length} files · {previewSummary(preview)}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {scopeHint ? (
        <Box>
          <Text color={theme.warning}>{scopeHint}</Text>
        </Box>
      ) : null}
      <Box>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          const btnColor = theme[btn.colorKey];
          const label = btn.value === 'always' ? `${btn.label} ${alwaysPatternDisplay}` : btn.label;
          return (
            <Box key={btn.label} marginRight={2}>
              <Text
                backgroundColor={isSelected ? theme.surfaceActive : undefined}
                color={isSelected ? theme.selectionText : btnColor}
                bold={isSelected}
              >
                {isSelected ? `${SELECTION_MARKER} ` : '  '}
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {density.showOptionalHelp ? (
        <Box>
          <Text color={theme.subtle} dimColor>
            {helpKeys.join(' · ')}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
