import { useMemo, useState } from 'react';
import { ListPicker } from './ListPicker.js';

export interface ThemeSelectionResult {
  ok: boolean;
  error?: string;
}

interface ThemePickerProps {
  current: string;
  customThemes?: readonly string[];
  onSelect: (name: string) => ThemeSelectionResult;
  onCancel: () => void;
}

const BUILTIN_THEMES = [
  { name: 'dark', description: 'Warm charcoal and muted sage' },
  { name: 'light', description: 'Soft parchment with grounded contrast' },
  { name: 'auto', description: 'Follow the terminal background' },
  { name: 'catppuccin', description: 'Soothing pastel mocha' },
  { name: 'nord', description: 'Arctic and glacial slate' },
  { name: 'gruvbox', description: 'Warm retro earthy dark' },
  { name: 'solarized-dark', description: 'Engineered low-fatigue teal' },
] as const;

const NO_CUSTOM_THEMES: readonly string[] = [];

export function ThemePicker({
  current,
  customThemes = NO_CUSTOM_THEMES,
  onSelect,
  onCancel,
}: ThemePickerProps) {
  const options = useMemo(
    () => [
      ...BUILTIN_THEMES,
      ...customThemes
        .filter((name) => !BUILTIN_THEMES.some((builtin) => builtin.name === name))
        .map((name) => ({ name, description: 'Project theme' })),
    ],
    [customThemes],
  );
  const [error, setError] = useState<string>();

  const items = useMemo(
    () =>
      options.map((option) => ({
        key: option.name,
        label: `${option.name.padEnd(16)} ${option.description}`,
        note: option.name === current ? '(current)' : undefined,
        accent: option.name === current,
      })),
    [current, options],
  );

  return (
    <ListPicker
      title="Choose theme"
      subtitle="Select a palette for this workspace."
      items={items}
      initialIndex={Math.max(
        0,
        options.findIndex((option) => option.name === current),
      )}
      enterHint="save"
      escHint="cancel"
      error={error}
      onSelect={(index) => {
        const option = options[index];
        if (!option) return;
        const result = onSelect(option.name);
        setError(result.ok ? undefined : (result.error ?? 'Could not save the selected theme.'));
      }}
      onCancel={onCancel}
    />
  );
}
