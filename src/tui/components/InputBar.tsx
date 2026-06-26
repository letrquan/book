import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';

const MODE_BORDER_TOKENS: Record<PermissionMode, 'brand' | 'success' | 'planMode' | 'autoAccept' | 'error'> = {
  default: 'brand',
  auto: 'success',
  plan: 'planMode',
  'accept-edits': 'autoAccept',
  dontAsk: 'error',
  bypassPermissions: 'success',
};

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  mode: PermissionMode;
  onCycleMode: () => void;
}

export function InputBar({ onSubmit, disabled, mode, onCycleMode }: InputBarProps) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const suggestion = 'Ask me anything...';

  useInput((_input, key) => {
    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }
    // Tab to accept suggestion when input is empty
    if (key.tab && !value) {
      setValue(suggestion);
      return;
    }
  });

  const handleSubmit = useCallback(
    (val: string) => {
      if (!val.trim() || disabled) return;
      setHistory((h) => [val, ...h].slice(0, 100));
      onSubmit(val);
      setValue('');
    },
    [disabled, onSubmit],
  );

  const tokenKey = MODE_BORDER_TOKENS[mode];
  const borderColor = theme[tokenKey];

  // Claude Code keeps the input visible at all times — even while the agent
  // is streaming. The prompt stays interactive (you can type your next message);
  // only submission is gated when disabled.
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={borderColor}>{'> '}</Text>
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Ask me anything..."
        />
      </Box>
      <Box marginLeft={1}>
        <Text color={borderColor}>[{mode}]</Text>
      </Box>
    </Box>
  );
}