import { Box, Text, useInput } from 'ink';
import { useCallback, useMemo, useRef, useEffect } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN } from '../layout.js';
import { useDensityMetrics } from '../density.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import { isFileMutatingTool } from '../../tools/tool-capabilities.js';
import { permissionRuleForToolCall, permissionRuleLadder } from '../../permissions.js';
import type { PermissionDecision, PermissionResult, ToolCall } from '../../types/tools.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const uiLog = createUiDebugLogger('tui:permbtn');
const PERMISSION_PATTERN_DISPLAY_MAX_LENGTH = 40;

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
 * Permission prompt card.
 *
 * Navigation:
 *   ←/→ or Tab/Shift+Tab — cycle between buttons
 *   Enter, or R/S — activate; A selects "Always allow" without activating it
 *   Esc — deny
 */
export function PermissionButtons({
  toolCall,
  onResolve,
  screenReader = false,
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
        <Text>Primary argument: {primaryArg || '(none)'}</Text>
        {hint ? <Text>Warning: {hint}</Text> : null}
        <Text>Press: [R] Run once, [S] Skip, [Esc] Deny.</Text>
        <Text>Always allow: press [A] to select it, then Enter to confirm.</Text>
        <Text>Rule to be saved: {alwaysPattern}</Text>
        {ladder.length > 1 ? <Text>Press [A] again to widen or narrow that rule.</Text> : null}
      </Box>
    );
  }

  return (
    <Box
      marginLeft={0}
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
        {primaryArg ? <Text color={theme.text}> {primaryArg.slice(0, 72)}</Text> : null}
      </Box>
      {hint ? (
        <Box>
          <Text color={risk === 'shell' ? theme.error : theme.warning}>{hint}</Text>
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
            {ladder.length > 1
              ? '← → select · Enter confirm · A scope · R run · S skip · Esc deny'
              : '← → select · Enter confirm · R run · S skip · Esc deny'}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
