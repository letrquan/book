import { Box, Text } from 'ink';
import { useState } from 'react';
import { useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { PermissionResult, ToolCall } from '../../types.js';

interface PermissionButtonsProps {
  toolCall: ToolCall;
  onResolve: (result: PermissionResult) => void;
}

const BUTTONS: { label: string; value: PermissionResult }[] = [
  { label: 'Run', value: 'allow' },
  { label: 'Skip', value: 'deny' },
  { label: 'Always allow', value: 'always' },
];

export function PermissionButtons({ toolCall, onResolve }: PermissionButtonsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.leftArrow) {
      setSelected((s) => (s - 1 + BUTTONS.length) % BUTTONS.length);
    } else if (key.rightArrow) {
      setSelected((s) => (s + 1) % BUTTONS.length);
    } else if (key.return) {
      onResolve(BUTTONS[selected].value);
    } else if (key.escape) {
      onResolve('deny');
    }
  });

  return (
    <Box marginLeft={2} marginY={1}>
      {BUTTONS.map((btn, i) => (
        <Box key={btn.label} marginRight={1}>
          <Text
            backgroundColor={i === selected ? 'white' : undefined}
            color={i === selected ? theme.inverseText : theme.text}
          >
            [{btn.label}]
          </Text>
        </Box>
      ))}
    </Box>
  );
}
