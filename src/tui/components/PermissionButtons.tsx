import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN } from '../layout.js';
import { useDensityMetrics } from '../density.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import { isFileMutatingTool } from '../../tools/tool-capabilities.js';
import { permissionRuleForToolCall } from '../../permissions.js';
import type { PermissionResult, ToolCall } from '../../types/tools.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const uiLog = createUiDebugLogger('tui:permbtn');
const PERMISSION_PATTERN_DISPLAY_MAX_LENGTH = 40;

interface PermissionButtonsProps {
  toolCall: ToolCall;
  onResolve: (result: PermissionResult) => void;
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
  const [selected, setSelected] = useState(0);
  // Enter reads the selection from a ref, not from render state. `A` now only
  // arms "Always allow", so `A` then a quick Enter lands in one React batch and
  // the Enter handler would still close over the previous index — resolving
  // `allow` when the user asked for `always`.
  const selectedRef = useRef(0);
  const resolvedToolCallIdRef = useRef<string | null>(null);
  const canonical = canonicalToolName(toolCall.name);
  const primaryArg = getPrimaryArg(toolCall.arguments);
  const risk = toolRiskLevel(toolCall);
  const hint = riskHint(risk);
  const alwaysPattern = permissionPatternForTool(toolCall, primaryArg);
  const alwaysPatternDisplay = permissionPatternForDisplay(alwaysPattern);

  // Track previous selection for old→new logging without stale closure issues.
  const prevSelectedRef = useRef(0);

  useDebugMount(uiLog, {
    tool: canonical,
    risk,
    primaryArg: primaryArg ? primaryArg.slice(0, 40) : null,
  });

  const moveSelection = useCallback((next: (current: number) => number) => {
    selectedRef.current = next(selectedRef.current);
    setSelected(selectedRef.current);
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
      uiLog.event('resolve', {
        tool: canonical,
        result: value,
        selected,
      });
      onResolve(value);
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
        const armed = selectedRef.current;
        uiLog.event('input:Enter', { tool: canonical, selected: armed });
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
        uiLog.event('input:shortcut', { tool: canonical, key: 'A', action: 'select-always' });
        moveSelection(() => BUTTONS.findIndex((button) => button.value === 'always'));
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
      <Box>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          const btnColor = theme[btn.colorKey];
          const label = btn.value === 'always' ? `${btn.label} ${alwaysPatternDisplay}` : btn.label;
          return (
            <Box key={btn.label} marginRight={1}>
              <Text
                backgroundColor={isSelected ? theme.surfaceActive : undefined}
                color={isSelected ? theme.selectionText : btnColor}
                bold={isSelected}
              >
                [{label}]
              </Text>
            </Box>
          );
        })}
      </Box>
      {density.showOptionalHelp ? (
        <Box>
          <Text color={theme.subtle} dimColor>
            ← → select · Enter confirm · R run · S skip · Esc deny
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
