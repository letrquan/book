import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import type { EffortLevel, EffortResult } from '../../commands/effort.js';

const DESCRIPTIONS: Record<EffortLevel, string> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Deeper reasoning for complex work',
  xhigh: 'Extended reasoning for difficult problems',
  max: 'Maximum reasoning depth for the hardest tasks',
};

interface EffortPickerProps {
  current?: EffortLevel;
  availableLevels: readonly EffortLevel[];
  onSelect: (level: EffortLevel) => EffortResult;
  onCancel: () => void;
}

export function EffortPicker({ current, availableLevels, onSelect, onCancel }: EffortPickerProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(() => {
    const currentIndex = current ? availableLevels.indexOf(current) : -1;
    return currentIndex >= 0 ? currentIndex : 0;
  });
  const selectedRef = useRef(selected);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const currentIndex = current ? availableLevels.indexOf(current) : -1;
    setSelected((index) => {
      const next =
        currentIndex >= 0 ? currentIndex : Math.min(index, Math.max(0, availableLevels.length - 1));
      selectedRef.current = next;
      return next;
    });
  }, [availableLevels, current]);

  useInput((_, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (availableLevels.length === 0) return;
    if (key.upArrow) {
      setSelected((index) => {
        const next = (index - 1 + availableLevels.length) % availableLevels.length;
        selectedRef.current = next;
        return next;
      });
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setSelected((index) => {
        const next = (index + 1) % availableLevels.length;
        selectedRef.current = next;
        return next;
      });
      setError(undefined);
      return;
    }
    if (key.return) {
      const level = availableLevels[selectedRef.current];
      if (!level) return;
      const result = onSelect(level);
      if (!result.ok) setError(result.error ?? 'Could not save the selected effort level.');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.brand}>
        Set effort level
      </Text>
      <Text color={theme.subtle}>Choose how much reasoning Book uses on future requests.</Text>
      <Box flexDirection="column" marginTop={1}>
        {availableLevels.map((level, index) => {
          const isSelected = index === selected;
          const isCurrent = level === current;
          return (
            <Text
              key={level}
              backgroundColor={isSelected ? theme.surfaceActive : undefined}
              color={isSelected ? theme.selectionText : isCurrent ? theme.brand : theme.text}
              bold={isSelected || isCurrent}
            >
              {isSelected ? '❯' : ' '} {level.padEnd(6)} {DESCRIPTIONS[level]}
              {isCurrent ? '  (current)' : ''}
            </Text>
          );
        })}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter save · Esc cancel
      </Text>
      {error && <Text color={theme.error}>✕ {error}</Text>}
    </Box>
  );
}
