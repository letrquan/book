import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useTheme } from '../theme.js';
import type { PermissionResult, ToolCall } from '../../types.js';

interface PermissionButtonsProps {
  toolCall: ToolCall;
  onResolve: (result: PermissionResult) => void;
  /** When true, disables all animations/colors for screen readers. */
  screenReader?: boolean;
}

const BUTTONS: { label: string; value: PermissionResult; key: string }[] = [
  { label: 'Run', value: 'allow', key: 'r' },
  { label: 'Skip', value: 'deny', key: 's' },
  { label: 'Always allow', value: 'always', key: 'a' },
];

/**
 * Claude Code-style permission prompt with 3 interactive buttons.
 *
 * Navigation:
 *   ←/→ arrow keys or Tab/Shift+Tab — cycle between buttons
 *   Enter/Space or R/S/A keys — activate selected button
 *   Esc — deny (cancel)
 *
 * Uses `useInput` with `isActive=true` to ensure input is captured even
 * when other components also use `useInput`. The parent (App) should check
 * `pendingPermission` and skip Esc handling when a permission prompt is
 * active.
 */
export function PermissionButtons({ toolCall, onResolve, screenReader = false }: PermissionButtonsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const resolvedRef = useRef(false);

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
      if (key.return) {
        handleResolve(BUTTONS[selected].value);
        return;
      }
      if (key.escape) {
        handleResolve('deny');
        return;
      }
      // Quick-key selection: R=Run, S=Skip, A=Always allow
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

  // If screen reader mode, render a simple text-based prompt.
  if (screenReader) {
    return (
      <Box marginLeft={2} marginY={1} flexDirection="column">
        <Text>Permission required for: {toolCall.name}</Text>
        <Text>Primary argument: {String(toolCall.arguments.command ?? toolCall.arguments.filePath ?? toolCall.arguments.path ?? '(none)')}</Text>
        <Text>Press: [R] Run [S] Skip [A] Always allow [Esc] Deny</Text>
      </Box>
    );
  }

  // Visual mode: styled buttons with highlight.
  return (
    <Box marginLeft={2} marginY={1} flexDirection="column">
      <Box>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          return (
            <Box key={btn.label} marginRight={1}>
              <Text
                backgroundColor={isSelected ? theme.brand : undefined}
                color={isSelected ? theme.inverseText : theme.subtle}
                bold={isSelected}
              >
                [{btn.label}]
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={0}>
        <Text color={theme.subtle} dimColor>
          ← → to select  •  Enter to confirm  •  Esc to deny
        </Text>
      </Box>
    </Box>
  );
}
