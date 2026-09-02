import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import { SelectionRow, SoftPanel, PanelTitle } from './chrome.js';

export interface PermissionModeSelectionResult {
  ok: boolean;
  error?: string;
}

interface PermissionModePickerProps {
  current: PermissionMode;
  availableModes: readonly PermissionMode[];
  onSelect: (mode: PermissionMode) => PermissionModeSelectionResult;
  onCancel: () => void;
}

const DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Ask according to configured permission rules',
  auto: 'Automatically approve eligible tool calls',
  plan: 'Plan changes before applying them',
  'accept-edits': 'Automatically approve file edits',
  dontAsk: 'Deny calls that would require prompting',
  bypassPermissions: 'Run without permission checks',
};

export function PermissionModePicker({
  current,
  availableModes,
  onSelect,
  onCancel,
}: PermissionModePickerProps) {
  const theme = useTheme();
  const [selected, setSelected, currentSelected] = useKeyState(() =>
    Math.max(0, availableModes.indexOf(current)),
  );
  const [error, setError] = useState<string>();

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) {
      setSelected((currentSelected() - 1 + availableModes.length) % availableModes.length);
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setSelected((currentSelected() + 1) % availableModes.length);
      setError(undefined);
      return;
    }
    if (key.return) {
      const mode = availableModes[currentSelected()];
      if (!mode) return;
      const result = onSelect(mode);
      if (!result.ok) setError(result.error ?? 'Could not save the default permission mode.');
    }
  });

  return (
    <SoftPanel tone="brand">
      <PanelTitle>Default permission mode</PanelTitle>
      <Text color={theme.subtle}>Choose the mode used when a run does not specify one.</Text>
      <Box flexDirection="column" marginTop={1}>
        {availableModes.map((mode, index) => (
          <SelectionRow key={mode} selected={index === selected}>
            {index === selected ? '›' : ' '} {mode.padEnd(18)} {DESCRIPTIONS[mode]}
            {mode === current ? '  (current)' : ''}
          </SelectionRow>
        ))}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter save globally · Esc cancel
      </Text>
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
    </SoftPanel>
  );
}
