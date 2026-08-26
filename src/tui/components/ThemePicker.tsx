import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../theme.js';
import { PanelTitle, SelectionRow, SoftPanel } from './chrome.js';

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
  const theme = useTheme();
  const options = useMemo(
    () => [
      ...BUILTIN_THEMES,
      ...customThemes
        .filter((name) => !BUILTIN_THEMES.some((builtin) => builtin.name === name))
        .map((name) => ({ name, description: 'Project theme' })),
    ],
    [customThemes],
  );
  const [selected, setSelected] = useState(() => {
    const index = options.findIndex((option) => option.name === current);
    return index >= 0 ? index : 0;
  });
  const [error, setError] = useState<string>();

  useEffect(() => {
    const index = options.findIndex((option) => option.name === current);
    setSelected(index >= 0 ? index : 0);
  }, [current, options]);

  useInput((_, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((index) => (index - 1 + options.length) % options.length);
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setSelected((index) => (index + 1) % options.length);
      setError(undefined);
      return;
    }
    if (key.return) {
      const option = options[selected];
      if (!option) return;
      const result = onSelect(option.name);
      if (!result.ok) setError(result.error ?? 'Could not save the selected theme.');
    }
  });

  return (
    <SoftPanel tone="brand">
      <PanelTitle>Choose theme</PanelTitle>
      <Text color={theme.subtle}>Select a palette for this workspace.</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const isSelected = index === selected;
          const isCurrent = option.name === current;
          return (
            <SelectionRow key={option.name} selected={isSelected}>
              {isSelected ? '›' : ' '} {option.name.padEnd(16)} {option.description}
              {isCurrent ? '  (current)' : ''}
            </SelectionRow>
          );
        })}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter save · Esc cancel
      </Text>
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
    </SoftPanel>
  );
}
