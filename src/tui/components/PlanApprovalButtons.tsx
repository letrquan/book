import { Box, Text, useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import type { PlanApprovalResult } from '../../types.js';

interface PlanApprovalButtonsProps {
  plan: string;
  onResolve: (result: PlanApprovalResult) => void;
  screenReader?: boolean;
}

const BUTTONS: Array<{ label: string; value: PlanApprovalResult; key: string }> = [
  { label: 'Approve plan', value: 'approve', key: 'a' },
  { label: 'Reject / revise', value: 'reject', key: 'r' },
];

export function PlanApprovalButtons({
  plan,
  onResolve,
  screenReader = false,
}: PlanApprovalButtonsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const resolvedRef = useRef(false);

  const handleResolve = useCallback(
    (value: PlanApprovalResult) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(value);
    },
    [onResolve],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow || key.rightArrow || key.tab) {
        setSelected((s) => (s + 1) % BUTTONS.length);
        return;
      }
      if (key.return || input === ' ') {
        handleResolve(BUTTONS[selected].value);
        return;
      }
      if (key.escape) {
        handleResolve('reject');
        return;
      }
      if (input === 'a' || input === 'A') {
        handleResolve('approve');
        return;
      }
      if (input === 'r' || input === 'R' || input === 's' || input === 'S') {
        handleResolve('reject');
      }
    },
    { isActive: true },
  );

  if (screenReader) {
    return (
      <Box marginLeft={2} marginY={1} flexDirection="column">
        <Text>Plan approval required.</Text>
        <Text>{plan}</Text>
        <Text>Press: [A] Approve [R] Reject [Esc] Reject</Text>
      </Box>
    );
  }

  return (
    <Box
      marginLeft={2}
      marginY={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.planMode}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.planMode}>
          Plan approval required
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {plan.split('\n').map((line, index) => (
          <Text key={index} color={theme.text}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          const color = btn.value === 'approve' ? theme.permission : theme.subtle;
          return (
            <Box key={btn.value} marginRight={1}>
              <Text
                backgroundColor={isSelected ? color : undefined}
                color={isSelected ? theme.inverseText : color}
                bold={isSelected}
              >
                [{btn.label}]
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        <Text color={theme.subtle} dimColor>
          ← → to select • Enter to confirm • A/R shortcuts • Esc to reject
        </Text>
      </Box>
    </Box>
  );
}
