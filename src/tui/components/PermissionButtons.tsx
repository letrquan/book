import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useRef } from 'react';
import { useTheme } from '../theme.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import type { PermissionResult, ToolCall } from '../../types.js';

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

export function toolRiskLevel(toolCall: ToolCall): 'safe' | 'write' | 'shell' {
  const name = canonicalToolName(toolCall.name);
  const lower = toolCall.name.toLowerCase();
  if (name === 'Bash' || lower.includes('bash') || lower === 'shell') return 'shell';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return 'write';
  if (lower === 'write' || lower === 'edit' || lower === 'multiedit') return 'write';
  return 'safe';
}

function riskHint(level: ReturnType<typeof toolRiskLevel>): string | null {
  if (level === 'shell') return 'This will run a shell command on your machine.';
  if (level === 'write') return 'This will modify files on disk.';
  return null;
}

function permissionPattern(toolCall: ToolCall, primaryArg: string): string {
  const name = canonicalToolName(toolCall.name);
  return primaryArg ? `${name}(${primaryArg.slice(0, 40)})` : name;
}

/**
 * Permission prompt card.
 *
 * Navigation:
 *   ←/→ or Tab/Shift+Tab — cycle between buttons
 *   Enter or R/S/A keys — activate selected button
 *   Esc — deny
 */
export function PermissionButtons({ toolCall, onResolve, screenReader = false }: PermissionButtonsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const resolvedRef = useRef(false);
  const canonical = canonicalToolName(toolCall.name);
  const primaryArg = getPrimaryArg(toolCall.arguments);
  const risk = toolRiskLevel(toolCall);
  const hint = riskHint(risk);
  const alwaysPattern = permissionPattern(toolCall, primaryArg);

  const handleResolve = useCallback(
    (value: PermissionResult) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(value);
    },
    [onResolve],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow) {
        setSelected((s) => (s - 1 + BUTTONS.length) % BUTTONS.length);
        return;
      }
      if (key.rightArrow) {
        setSelected((s) => (s + 1) % BUTTONS.length);
        return;
      }
      if (key.tab) {
        setSelected((s) => (key.shift ? (s - 1 + BUTTONS.length) % BUTTONS.length : (s + 1) % BUTTONS.length));
        return;
      }
      if (key.return || input === ' ') {
        handleResolve(BUTTONS[selected].value);
        return;
      }
      if (key.escape) {
        handleResolve('deny');
        return;
      }
      if (input === 'r' || input === 'R') {
        handleResolve('allow');
        return;
      }
      if (input === 's' || input === 'S') {
        handleResolve('deny');
        return;
      }
      if (input === 'a' || input === 'A') {
        handleResolve('always');
        return;
      }
    },
    { isActive: true },
  );

  if (screenReader) {
    return (
      <Box marginLeft={2} marginY={1} flexDirection="column">
        <Text>Permission required for: {canonical}</Text>
        <Text>Primary argument: {primaryArg || '(none)'}</Text>
        {hint ? <Text>Warning: {hint}</Text> : null}
        <Text>Press: [R] Run once [S] Skip [A] Always allow [Esc] Deny</Text>
      </Box>
    );
  }

  return (
    <Box
      marginLeft={2}
      marginY={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={risk === 'shell' ? theme.error : risk === 'write' ? theme.warning : theme.permission}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.permission}>Permission required</Text>
      </Box>
      <Box>
        <Text bold color={theme.brand}>{canonical}</Text>
        {primaryArg ? <Text color={theme.text}> {primaryArg.slice(0, 80)}</Text> : null}
      </Box>
      {hint ? (
        <Box>
          <Text color={risk === 'shell' ? theme.error : theme.warning}>{hint}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          const btnColor = theme[btn.colorKey];
          const label = btn.value === 'always' ? `${btn.label} ${alwaysPattern}` : btn.label;
          return (
            <Box key={btn.label} marginRight={1}>
              <Text
                backgroundColor={isSelected ? btnColor : undefined}
                color={isSelected ? theme.inverseText : btnColor}
                bold={isSelected}
              >
                [{label}]
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        <Text color={theme.subtle} dimColor>
          ← → to select  •  Enter to confirm  •  R/S/A shortcuts  •  Esc to deny
        </Text>
      </Box>
    </Box>
  );
}
