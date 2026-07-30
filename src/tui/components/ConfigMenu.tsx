import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useTheme } from '../theme.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';
import { truncateDisplay } from './word-wrap.js';

export type ConfigSection = 'model' | 'effort' | 'theme' | 'agents' | 'permission-mode';

interface ConfigMenuProps {
  model: string;
  effort?: string;
  themeName: string;
  memoryAutoSave: boolean;
  showThinking: boolean;
  agentCount: number;
  defaultPermissionMode: string;
  terminalWidth?: number;
  onOpen: (section: ConfigSection) => void;
  onToggleMemory: () => void;
  onToggleThinking: () => void;
  onCancel: () => void;
}

const ROWS = [
  'model',
  'effort',
  'thinking',
  'theme',
  'permission-mode',
  'agents',
  'memory',
] as const;
type Row = (typeof ROWS)[number];

export function ConfigMenu({
  model,
  effort,
  themeName,
  memoryAutoSave,
  showThinking,
  agentCount,
  defaultPermissionMode,
  terminalWidth = 80,
  onOpen,
  onToggleMemory,
  onToggleThinking,
  onCancel,
}: ConfigMenuProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const frame = floatingFrameMetrics(terminalWidth);
  const contentWidth = Math.max(16, frame.width - 4);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) {
      setSelected((index) => (index - 1 + ROWS.length) % ROWS.length);
      return;
    }
    if (key.downArrow || key.tab) {
      setSelected((index) => (index + 1) % ROWS.length);
      return;
    }
    if (key.return) {
      const row = ROWS[selected];
      if (row === 'memory') onToggleMemory();
      else if (row === 'thinking') onToggleThinking();
      else onOpen(row);
      return;
    }
    const shortcut = input.toLowerCase();
    if (shortcut === 'm') onOpen('model');
    else if (shortcut === 'e') onOpen('effort');
    else if (shortcut === 'i') onToggleThinking();
    else if (shortcut === 't') onOpen('theme');
    else if (shortcut === 'a') onOpen('agents');
    else if (shortcut === 'p') onOpen('permission-mode');
  });

  const rows: Array<{ row: Row; label: string; value: string; description: string }> = [
    { row: 'model', label: 'Model', value: model, description: 'Default model for the main agent' },
    {
      row: 'effort',
      label: 'Effort',
      value: effort ?? 'model default',
      description: 'Reasoning depth for supported models',
    },
    {
      row: 'thinking',
      label: 'Show thinking',
      value: showThinking ? 'on' : 'off',
      description: 'Display the model reasoning in the transcript',
    },
    { row: 'theme', label: 'Theme', value: themeName, description: 'Terminal color palette' },
    {
      row: 'permission-mode',
      label: 'Default permissions',
      value: defaultPermissionMode,
      description: 'Mode for runs without an explicit override',
    },
    {
      row: 'agents',
      label: 'Subagent profiles',
      value: `${agentCount} available`,
      description: 'Choose a model for explorer, patcher, or validator',
    },
    {
      row: 'memory',
      label: 'Memory auto-capture',
      value: memoryAutoSave ? 'on' : 'off',
      description: 'Capture useful corrections for approval later',
    },
  ];

  return (
    <SoftPanel tone="brand" width={frame.width} marginX={frame.marginX}>
      <PanelTitle>Settings</PanelTitle>
      <Text color={theme.subtle}>Choose a setting to change.</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((item, index) => (
          <SelectionRow key={item.row} selected={index === selected} width={contentWidth}>
            {index === selected ? '›' : ' '}{' '}
            {truncateDisplay(
              `${item.label.padEnd(22)} ${item.value} — ${item.description}`,
              contentWidth - 2,
            )}
          </SelectionRow>
        ))}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter toggle/open · I thinking · M model · P permissions · A agents · Esc close
      </Text>
    </SoftPanel>
  );
}
