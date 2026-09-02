import { useMemo, useState } from 'react';
import { ListPicker } from './ListPicker.js';
import type { PermissionMode } from '../../types/runtime.js';

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
  const [error, setError] = useState<string>();

  const items = useMemo(
    () =>
      availableModes.map((mode) => ({
        key: mode,
        label: `${mode.padEnd(18)} ${DESCRIPTIONS[mode]}`,
        note: mode === current ? '(current)' : undefined,
        accent: mode === current,
      })),
    [availableModes, current],
  );

  return (
    <ListPicker
      title="Default permission mode"
      subtitle="Choose the mode used when a run does not specify one."
      items={items}
      initialIndex={Math.max(0, availableModes.indexOf(current))}
      enterHint="save globally"
      escHint="cancel"
      error={error}
      onSelect={(index) => {
        const mode = availableModes[index];
        if (!mode) return;
        const result = onSelect(mode);
        setError(
          result.ok ? undefined : (result.error ?? 'Could not save the default permission mode.'),
        );
      }}
      onCancel={onCancel}
    />
  );
}
