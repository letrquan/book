import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback } from 'react';
import { useInput } from 'ink';
import type { PermissionMode } from '../../types.js';

const MODE_BORDER_COLORS: Record<PermissionMode, string> = {
  default: 'cyan',
  auto: 'yellow',
  plan: 'magenta',
  'accept-edits': 'green',
};

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  mode: PermissionMode;
  onCycleMode: () => void;
}

export function InputBar({ onSubmit, disabled, mode, onCycleMode }: InputBarProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  useInput((_input, key) => {
    if (key.shift && key.tab) {
      onCycleMode();
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

  return (
    <Box borderStyle="round" borderColor={MODE_BORDER_COLORS[mode]} paddingX={1}>
      {disabled ? (
        <Text color="gray">(thinking...)</Text>
      ) : (
        <>
          <Text color={MODE_BORDER_COLORS[mode]}>{'> '}</Text>
          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
            />
          </Box>
        </>
      )}
      <Box marginLeft={1}>
        <Text color={MODE_BORDER_COLORS[mode]}>[{mode}]</Text>
      </Box>
    </Box>
  );
}
